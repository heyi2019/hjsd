"""REVERSAL-02 同一笔流水的冲销、编辑和删除必须串行检查。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Barrier, Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app.core.errors import AppError, Validation
from app.domain.base import Base
from app.domain.enums import AccountingAttribute, Direction
from app.domain.foundation import AuditLog, Pool
from app.domain.trade import BalanceSnapshot, Cashflow, Deposit, OrderEvent, RebateRecord, Reconciliation
from app.domain.users import User
from app.funds.balances import pool_balance
from app.funds.transfers import create_transfer, repair_transfer
from app.funds.deposits.lifecycle import return_deposit, lose_deposit, cancel_deposit
from app.funds.deposits.writes import create_deposit, update_deposit, delete_deposit
from app.funds.reconciliation import create_reconciliation, resolve_reconciliation
from app.funds.cashflows import create_cashflow, delete_cashflow, reverse_cashflow, update_cashflow
from app.settings.field_definitions.seeds import seed_foundation
from app.business.create import create_order
from app.business.inventory.profile import create_account
from app.funds.rebates import create_rebate, update_rebate

pytestmark = pytest.mark.db


def test_rebate_service_and_order_date_edit_keep_latest_data(v1_engine):
    from app.business.order_detail.editing.editor import edit_execution_detail
    from app.business.order_detail.editing.schemas import ExecutionEditRequest
    from app.core.security import CurrentUser

    database = f"heijin_rebate_date_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            account = create_account(session, game_account="rebate-date-race", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest", account_id=account.id)
            rebate = create_rebate(session, source_order_id=order.id, rebate_type="BUY", amount="100", collected_on=day, actor="pytest")
            action = session.scalar(select(OrderEvent).where(OrderEvent.source_type == "REBATE", OrderEvent.source_id == rebate.rebate_no))
            flow = session.scalar(select(Cashflow).where(Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == action.event_no))
            order_id, rebate_id, event_id, flow_id = order.id, rebate.id, action.id, flow.id
            session.commit()
        reached = Event()

        def edit_date():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    if "from pools" in statement.lower() and "for no key update" in statement.lower():
                        reached.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                user = CurrentUser(id=1, username="pytest", roles=("ADMIN",), owner_scope="ALL")
                payload = ExecutionEditRequest.model_validate({"events": [{"id": event_id, "expected_amount": "100", "amount": "100", "occurred_at": "2026-11-02T12:00:00"}]})
                edit_execution_detail(session, order_id, payload, user)
                session.commit()

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            update_rebate(first, rebate_id, note="新备注", actor="pytest")
            future = executor.submit(edit_date)
            assert reached.wait(10), "订单编辑未等待资金账户锁"
            first.commit()
            future.result(timeout=10)
        with factory() as session:
            rebate = session.get(RebateRecord, rebate_id)
            action = session.get(OrderEvent, event_id)
            flow = session.get(Cashflow, flow_id)
            assert rebate.note == action.note == "新备注"
            assert rebate.collected_on == action.occurred_on == flow.occurred_on == date(2026, 11, 2)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("first_action", ["edit", "reconcile"])
@pytest.mark.parametrize("edit_kind", ["order", "rebate"])
def test_reconciliation_and_amount_edit_serialize(v1_engine, first_action, edit_kind):
    from app.business.events import post_event
    from app.business.order_detail.editing.editor import edit_execution_detail
    from app.business.order_detail.editing.schemas import ExecutionEditRequest
    from app.core.security import CurrentUser
    from app.funds.reconciliation import _system_balance_as_of

    database = f"heijin_recon_edit_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            session.flush()
            account = create_account(session, game_account="reconciliation-edit-race", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest", account_id=account.id)
            if edit_kind == "order":
                action, _ = post_event(session, order.id, event_type="BUY", amount="100", occurred_on=day, actor="pytest")
                rebate_id = None
            else:
                rebate = create_rebate(session, source_order_id=order.id, rebate_type="BUY", amount="100", collected_on=day, actor="pytest")
                rebate_id = rebate.id
                action = session.scalar(select(OrderEvent).where(OrderEvent.source_type == "REBATE", OrderEvent.source_id == rebate.rebate_no))
            flow = session.scalar(select(Cashflow).where(Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == action.event_no))
            order_id, event_id, pool_id = order.id, action.id, flow.pool_id
            session.commit()

        user = CurrentUser(id=1, username="pytest", roles=("ADMIN",), owner_scope="ALL")
        payload = ExecutionEditRequest.model_validate({"events": [{"id": event_id, "expected_amount": "100", "amount": "200"}]})
        reached, proceed, first_locked_pool = Event(), Event(), Event()

        def action(session, name):
            if name == "edit":
                if edit_kind == "order":
                    edit_execution_detail(session, order_id, payload, user)
                else:
                    update_rebate(session, rebate_id, amount="200", actor="pytest", user=user)
            else:
                create_reconciliation(session, pool_id=pool_id, reconciled_on=day, account_label="并发账户",
                                      statement_balance="0", reason="核对", actor="pytest")

        def second_action():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from pools" in sql and "for no key update" in sql and first_locked_pool.is_set():
                        reached.set()
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    legacy_snapshot = first_action == "edit" and "from cashflow" in sql and "sum(" in sql
                    legacy_guard = first_action == "reconcile" and (
                        "from reconciliations" in sql or
                        (edit_kind == "rebate" and "from cashflow" in sql and "for update" in sql)
                    )
                    if not first_locked_pool.is_set() and not reached.is_set() and (legacy_snapshot or legacy_guard):
                        reached.set()
                        assert proceed.wait(10)
                event.listen(session.connection(), "before_cursor_execute", before)
                event.listen(session.connection(), "after_cursor_execute", after)
                try:
                    action(session, "reconcile" if first_action == "edit" else "edit")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            def first_after(_conn, _cursor, statement, _parameters, _context, _many):
                sql = statement.lower()
                if "from pools" in sql and "for no key update" in sql:
                    first_locked_pool.set()
            event.listen(first.connection(), "after_cursor_execute", first_after)
            action(first, first_action)
            # 对账本身始终加池锁；编辑只有修复后才加相同的锁。
            if first_action == "reconcile":
                first_locked_pool.clear()
                # 第二个编辑若使用池锁会先报告等待；旧实现会报告已过对账检查。
                def editing_before(_conn, _cursor, statement, _parameters, _context, _many):
                    if "from pools" in statement.lower() and "for no key update" in statement.lower():
                        reached.set()
                # 通过下方连接监听统一捕获，不改变事务时序。
                event.listen(engine, "before_cursor_execute", editing_before)
            future = executor.submit(second_action)
            try:
                assert reached.wait(10), "第二个操作未到达资金账户锁或对账检查"
                first.commit()
            finally:
                proceed.set()
                if first_action == "reconcile":
                    event.remove(engine, "before_cursor_execute", editing_before)
            assert future.result(timeout=10) == ("accepted" if first_action == "edit" else "rejected")

        with factory() as session:
            recon = session.scalar(select(Reconciliation).where(Reconciliation.pool_id == pool_id))
            expected = 200 if first_action == "edit" else 100
            assert recon.system_balance == (expected if edit_kind == "rebate" else -expected)
            assert _system_balance_as_of(session, pool_id, day) == recon.system_balance
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("first_action", ["reverse", "edit"])
def test_rebate_edit_and_reversal_serialize(v1_engine, first_action):
    database = f"heijin_rebate_reverse_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            account = create_account(session, game_account="rebate-reversal", business_mode="SELF",
                                     inventory_type="RECOVERY", actor="pytest")
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest", account_id=account.id)
            rebate = create_rebate(session, source_order_id=order.id, rebate_type="BUY", amount="100",
                                   collected_on=day, actor="pytest")
            action = session.scalar(select(OrderEvent).where(OrderEvent.source_type == "REBATE", OrderEvent.source_id == rebate.rebate_no))
            flow = session.scalar(select(Cashflow).where(Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == action.event_no))
            rebate_id, event_id, flow_id, flow_no = rebate.id, action.id, flow.id, flow.flow_no
            session.commit()

        reached, proceed = Event(), Event()
        def run_action(session, action_name):
            if action_name == "reverse":
                reverse_cashflow(session, flow_id, reversed_on=day, actor="pytest", reason="错录")
            else:
                update_rebate(session, rebate_id, amount="200", actor="pytest")

        def second_action():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from cashflow" in sql and "for update" in sql:
                        reached.set()
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from cashflow" in sql and "for update" not in sql and not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)
                event.listen(session.connection(), "before_cursor_execute", before)
                event.listen(session.connection(), "after_cursor_execute", after)
                try:
                    run_action(session, "edit" if first_action == "reverse" else "reverse")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            run_action(first, first_action)
            future = executor.submit(second_action)
            try:
                assert reached.wait(10), "第二个操作未到达流水查询"
                first.commit()
            finally:
                proceed.set()
            assert future.result(timeout=10) == ("rejected" if first_action == "reverse" else "accepted")

        with factory() as session:
            rebate = session.get(RebateRecord, rebate_id)
            action = session.get(OrderEvent, event_id)
            flow = session.get(Cashflow, flow_id)
            reversal = session.scalar(select(Cashflow).where(Cashflow.source_type == "REVERSAL", Cashflow.source_id == flow_no))
            expected = 100 if first_action == "reverse" else 200
            assert [rebate.amount, action.amount, flow.amount, reversal.amount] == [expected] * 4
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_concurrent_rebate_edits_keep_record_event_and_flow_consistent(v1_engine):
    database = f"heijin_rebate_concurrency_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            account = create_account(session, game_account="rebate-concurrent", business_mode="SELF",
                                     inventory_type="RECOVERY", actor="pytest")
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest", account_id=account.id)
            rebate = create_rebate(session, source_order_id=order.id, rebate_type="BUY", amount="100",
                                   collected_on=day, actor="pytest")
            rebate_id, rebate_no = rebate.id, rebate.rebate_no
            session.commit()

        reached, proceed = Event(), Event()
        with factory() as second:
            # 模拟路由或其他调用方提前读取返点记录。
            preloaded = second.get(RebateRecord, rebate_id)
            assert preloaded.amount == 100
            def before(_conn, _cursor, statement, _parameters, _context, _many):
                sql = statement.lower()
                if (("from rebate_records" in sql and "for update" in sql) or "from order_events" in sql
                        or ("from pools" in sql and "for no key update" in sql)):
                    if not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)
            event.listen(second.connection(), "before_cursor_execute", before)

            def edit_date():
                update_rebate(second, rebate_id, collected_on=date(2026, 11, 2), actor="second")
                second.commit()

            with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
                update_rebate(first, rebate_id, amount="200", actor="first")
                future = executor.submit(edit_date)
                try:
                    assert reached.wait(10), "第二次编辑未到达返点或事件查询"
                    first.commit()
                finally:
                    proceed.set()
                future.result(timeout=10)

        with factory() as session:
            rebate = session.get(RebateRecord, rebate_id)
            action = session.scalar(select(OrderEvent).where(OrderEvent.source_type == "REBATE", OrderEvent.source_id == rebate_no))
            flow = session.scalar(select(Cashflow).where(Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == action.event_no))
            assert [rebate.amount, action.amount, flow.amount] == [200, 200, 200]
            assert [rebate.collected_on, action.occurred_on, flow.occurred_on] == [date(2026, 11, 2)] * 3
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("same_account", [True, False])
def test_concurrent_reconciliation_creation_keeps_one_snapshot(v1_engine, same_account):
    database = f"heijin_recon_concurrency_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            pool_id = session.scalar(select(Pool.id).where(Pool.code == "HJ_INVEST"))
            session.commit()
        reached, proceed = Event(), Event()
        day = date(2026, 11, 1)

        def second():
            with factory() as session:
                connection = session.connection()
                def before(_conn, _cursor, sql, _parameters, _context, _many):
                    sql = sql.lower()
                    if "from pools" in sql and "for no key update" in sql:
                        reached.set()
                def after(_conn, _cursor, sql, _parameters, _context, _many):
                    if "from reconciliations" in sql.lower() and not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)
                event.listen(connection, "before_cursor_execute", before)
                event.listen(connection, "after_cursor_execute", after)
                try:
                    create_reconciliation(session, pool_id=pool_id, reconciled_on=day,
                                          account_label="甲" if same_account else "乙",
                                          statement_balance="0", actor="pytest")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            create_reconciliation(first, pool_id=pool_id, reconciled_on=day,
                                  account_label="甲", statement_balance="0", actor="pytest")
            future = executor.submit(second)
            try:
                assert reached.wait(10), "第二次对账未到达检查"
                first.commit()
            finally:
                proceed.set()
            assert future.result(timeout=10) == ("rejected" if same_account else "accepted")
        with factory() as session:
            assert len(session.scalars(select(Reconciliation)).all()) == (1 if same_account else 2)
            assert len(session.scalars(select(BalanceSnapshot)).all()) == 1
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("action", ["return", "partial", "loss", "cancel", "edit", "delete", "resolve"])
def test_deposit_and_reconciliation_competing_actions_are_serialized(v1_engine, action):
    database = f"heijin_fund_concurrency_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            pool = session.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
            pool_id = pool.id
            if action == "resolve":
                row = create_reconciliation(session, pool_id=pool_id, reconciled_on=day,
                                            account_label="并发账户", statement_balance="0", actor="pytest")
            else:
                row = create_deposit(session, pool_id=pool_id, amount="100", paid_on=day, actor="pytest")
            row_id = row.id
            session.commit()
        reached, proceed = Event(), Event()
        table = "reconciliations" if action == "resolve" else "deposits"

        def second():
            with factory() as session:
                # 路由可能提前读取实体；加锁时仍必须刷新会话里的旧对象。
                preloaded = session.get(Reconciliation if action == "resolve" else Deposit, row_id)
                assert preloaded is not None
                connection = session.connection()

                def before(_conn, _cursor, sql, _parameters, _context, _many):
                    sql = sql.lower()
                    if f"from {table}" in sql and "for update" in sql:
                        reached.set()

                def after(_conn, _cursor, sql, _parameters, _context, _many):
                    if f"from {table}" in sql.lower() and not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)

                event.listen(connection, "before_cursor_execute", before)
                event.listen(connection, "after_cursor_execute", after)
                try:
                    if action in {"return", "partial", "delete"}:
                        return_deposit(session, row_id, amount="40" if action == "partial" else "60", released_on=day, actor="pytest")
                    elif action == "loss":
                        lose_deposit(session, row_id, amount="60", lost_on=day, category="OTHER", reason="损失", actor="pytest")
                    elif action == "cancel":
                        cancel_deposit(session, row_id, cancelled_on=day, reason="取消", actor="pytest")
                    elif action == "edit":
                        update_deposit(session, row_id, pool_id=pool_id, amount="200", paid_on=day, actor="pytest")
                    else:
                        resolve_reconciliation(session, row_id, actor="pytest", reason="第二次核销")
                    session.commit()
                    return "accepted"
                except AppError:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            if action == "resolve":
                resolve_reconciliation(first, row_id, actor="pytest", reason="首次核销")
            elif action == "delete":
                delete_deposit(first, row_id, actor="pytest")
            else:
                return_deposit(first, row_id, amount="60", released_on=day, actor="pytest")
            future = executor.submit(second)
            try:
                assert reached.wait(10), "并发请求未到达记录读取"
                first.commit()
            finally:
                proceed.set()
            assert future.result(timeout=10) == ("accepted" if action == "partial" else "rejected")
        with factory() as session:
            if action == "resolve":
                row = session.get(Reconciliation, row_id)
                assert row.status == "RESOLVED" and row.reason == "首次核销"
                assert len(session.scalars(select(AuditLog).where(AuditLog.entity_type == "reconciliation", AuditLog.action == "RECONCILIATION_RESOLVE")).all()) == 1
            elif action == "delete":
                assert session.get(Deposit, row_id) is None
            else:
                row = session.get(Deposit, row_id)
                assert row.returned_amount == (100 if action == "partial" else 60)
                assert row.lost_amount == 0 and row.paid_amount == 100
                flows = session.scalars(select(Cashflow).where(Cashflow.source_type == "DEPOSIT", Cashflow.source_id == str(row_id))).all()
                assert sorted(flow.category for flow in flows) == ["DEPOSIT_HOLD"] + ["DEPOSIT_RELEASE"] * (2 if action == "partial" else 1)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_concurrent_transfer_repairs_only_create_one_counterpart(v1_engine):
    database = f"heijin_repair_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            source = session.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
            target = session.scalar(select(Pool).where(Pool.code == "HJ_PROFIT"))
            target_id = target.id
            session.add(Cashflow(flow_no="TEST-REPAIR-OUT", pool_id=source.id,
                                 occurred_on=date(2026, 11, 1), direction="OUT", amount=100,
                                 source_type="TRANSFER", source_id="TRF-REPAIR-TEST",
                                 accounting_attribute="INTERNAL_TRANSFER", category="TRANSFER",
                                 created_by="pytest", updated_by="pytest"))
            session.commit()
        reached, proceed = Event(), Event()

        def competing_repair():
            with factory() as session:
                connection = session.connection()

                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "cashflow" in sql and "for update" in sql:
                        reached.set()

                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "where cashflow.source_type =" in sql and not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)

                event.listen(connection, "before_cursor_execute", before)
                event.listen(connection, "after_cursor_execute", after)
                try:
                    repair_transfer(session, "TRF-REPAIR-TEST", counterpart_pool_id=target_id,
                                    actor="pytest", reason="补齐")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            repair_transfer(first, "TRF-REPAIR-TEST", counterpart_pool_id=target_id,
                            actor="pytest", reason="补齐")
            future = executor.submit(competing_repair)
            try:
                assert reached.wait(10), "第二次修复未到达查询"
                first.commit()
            finally:
                proceed.set()
            assert future.result(timeout=10) == "rejected"
        with factory() as session:
            flows = session.scalars(select(Cashflow).where(Cashflow.source_id == "TRF-REPAIR-TEST")).all()
            assert len(flows) == 2
            assert sorted(flow.direction for flow in flows) == ["IN", "OUT"]
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("action", ["reverse", "edit", "delete"])
def test_concurrent_actions_cannot_change_reversed_flow(v1_engine, action):
    database = f"heijin_cashflow_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            pool = session.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
            flow = create_cashflow(session, pool_id=pool.id, occurred_on=date(2026, 11, 1),
                                   ledger_type="STUDIO", direction="OUT", category="房租", amount="100", actor="pytest")
            flow_id, flow_no, pool_id = flow.id, flow.flow_no, pool.id
            session.commit()

        waiting = Event()
        release = Event()

        def competing_action():
            with factory() as session:
                connection = session.connection()

                def before(_conn, _cursor, statement, _parameters, _context, _executemany):
                    if "for update" in statement.lower() and "cashflow" in statement.lower():
                        waiting.set()

                def after(_conn, _cursor, statement, _parameters, _context, _executemany):
                    sql = statement.lower()
                    if "where cashflow.source_type =" in sql:
                        waiting.set()
                        release.wait(10)

                event.listen(connection, "before_cursor_execute", before)
                event.listen(connection, "after_cursor_execute", after)
                try:
                    if action == "reverse":
                        reverse_cashflow(session, flow_id, reversed_on=date(2026, 11, 2), actor="pytest", reason="重复")
                    elif action == "edit":
                        update_cashflow(session, flow_id, pool_id=pool_id, occurred_on=date(2026, 11, 1),
                                        direction="OUT", category="房租", amount="200", actor="pytest")
                    else:
                        delete_cashflow(session, flow_id, actor="pytest")
                    session.commit()
                    return "accepted"
                except AppError:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            reverse_cashflow(first, flow_id, reversed_on=date(2026, 11, 2), actor="pytest", reason="错录")
            future = executor.submit(competing_action)
            assert waiting.wait(10), "并发请求未到达流水校验"
            first.commit()
            release.set()
            assert future.result(timeout=10) == "rejected"

        with factory() as session:
            original = session.get(Cashflow, flow_id)
            reversals = session.scalars(select(Cashflow).where(
                Cashflow.source_type == "REVERSAL", Cashflow.source_id == flow_no,
            )).all()
            assert original is not None and original.amount == 100
            assert len(reversals) == 1 and reversals[0].amount == 100
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_concurrent_transfers_cannot_overspend(v1_engine):
    database = f"heijin_transfer_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            source = session.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
            target = session.scalar(select(Pool).where(Pool.code == "HJ_PROFIT"))
            source_id, target_id = source.id, target.id
            session.add(Cashflow(flow_no="TEST-CONCURRENT-IN", pool_id=source_id,
                                 occurred_on=date(2026, 11, 1), direction=Direction.IN.value,
                                 accounting_attribute=AccountingAttribute.SELF_REVENUE.value,
                                 category="OTHER", amount=100, created_by="pytest", updated_by="pytest"))
            session.commit()
        reached = Event()
        proceed = Event()

        def second_transfer():
            with factory() as session:
                connection = session.connection()

                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if ("for update" in sql or "for no key update" in sql) and "pool" in sql:
                        reached.set()
                        assert proceed.wait(10)

                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    if "group by cashflow.pool_id" in statement.lower() and not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)

                event.listen(connection, "before_cursor_execute", before)
                event.listen(connection, "after_cursor_execute", after)
                try:
                    create_transfer(session, source_pool_id=source_id, target_pool_id=target_id,
                                    amount="80", occurred_on=date(2026, 11, 2), actor="pytest")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            create_transfer(first, source_pool_id=source_id, target_pool_id=target_id,
                            amount="80", occurred_on=date(2026, 11, 2), actor="pytest")
            future = executor.submit(second_transfer)
            try:
                assert reached.wait(10), "第二笔划转未到达余额校验"
                first.commit()
            finally:
                proceed.set()
            assert future.result(timeout=10) == "rejected"

        with factory() as session:
            assert pool_balance(session, source_id)["available"] == 20

        # 两个账户反向互转时，持有各自的账户锁后仍须能插入对端流水。
        both_locked = Barrier(2, timeout=10)

        def reverse_transfer(from_id, to_id):
            with factory() as session:
                def after_lock(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if ("for update" in sql or "for no key update" in sql) and "pool" in sql:
                        both_locked.wait()

                event.listen(session.connection(), "after_cursor_execute", after_lock)
                create_transfer(session, source_pool_id=from_id, target_pool_id=to_id,
                                amount="10", occurred_on=date(2026, 11, 2), actor="pytest")
                session.commit()

        with ThreadPoolExecutor(max_workers=2) as executor:
            forward = executor.submit(reverse_transfer, source_id, target_id)
            backward = executor.submit(reverse_transfer, target_id, source_id)
            forward.result(timeout=20)
            backward.result(timeout=20)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()
