"""REVERSAL-02 同一笔流水的冲销、编辑和删除必须串行检查。"""
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import date
from threading import Barrier, Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, inspect, select
from sqlalchemy.orm import sessionmaker

from app.core.errors import AppError, Validation
from app.domain.base import Base
from app.domain.enums import AccountingAttribute, Direction
from app.domain.foundation import AuditLog, Pool
from app.domain.trade import BalanceSnapshot, Cashflow, Deposit, OrderEvent, RebateRecord, Reconciliation
from app.domain.users import User
from app.finance.balances import pool_balance
from app.finance.transfers import create_transfer, repair_transfer
from app.finance.deposits.lifecycle import return_deposit, lose_deposit, cancel_deposit
from app.finance.deposits.writes import create_deposit, update_deposit
from app.finance.reconciliation.service import create_reconciliation, resolve_reconciliation
from app.finance.cashflow.cashflows import create_cashflow, delete_cashflow, reverse_cashflow, update_cashflow
from app.settings.field_definitions.seeds import seed_foundation
from app.business.orders.create import create_order
from app.business.inventory.profile import create_account
from app.finance.rebates import create_rebate, update_rebate

pytestmark = pytest.mark.db


@pytest.fixture(scope="module")
def concurrency_schema_template(v1_engine):
    """为并发测试创建可复制的临时数据库模板。"""
    database = f"heijin_cashflow_template_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    created = False
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
        created = True
        template_engine = create_engine(v1_engine.url.set(database=database))
        try:
            Base.metadata.create_all(template_engine)
        finally:
            # PostgreSQL 不允许复制仍有活动连接的模板库。
            template_engine.dispose()
        yield database
    finally:
        try:
            if created:
                with admin.connect() as connection:
                    connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        finally:
            admin.dispose()


def test_concurrency_template_creates_independent_databases(v1_engine, concurrency_schema_template):
    """复制后的测试库包含完整结构，提交数据不会流入其他测试库或模板。"""
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    databases = [f"heijin_cashflow_probe_test_{uuid4().hex}" for _ in range(3)]
    created = []
    engines = []
    try:
        for database in databases[:2]:
            with admin.connect() as connection:
                connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
            created.append(database)
            engines.append(create_engine(v1_engine.url.set(database=database)))

        assert inspect(engines[0]).has_table("users")
        assert inspect(engines[1]).has_table("users")
        factory = sessionmaker(bind=engines[0])
        with factory() as session:
            session.add(User(username="isolation-probe", display_name="测试", password_hash="unused"))
            session.commit()
        factory = sessionmaker(bind=engines[1])
        with factory() as session:
            assert session.scalar(select(User).where(User.username == "isolation-probe")) is None

        # 一份库写入后再次从模板复制，不能继承先前测试的数据。
        with admin.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{databases[2]}" TEMPLATE "{concurrency_schema_template}"')
        created.append(databases[2])
        engines.append(create_engine(v1_engine.url.set(database=databases[2])))
        factory = sessionmaker(bind=engines[2])
        with factory() as session:
            assert session.scalar(select(User).where(User.username == "isolation-probe")) is None
    finally:
        for engine in engines:
            engine.dispose()
        try:
            with admin.connect() as connection:
                for database in reversed(created):
                    connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        finally:
            admin.dispose()


def test_rebate_service_and_order_date_edit_keep_latest_data(v1_engine, concurrency_schema_template):
    from app.business.shared.order_detail.editing.editor import edit_execution_detail
    from app.business.shared.order_detail.editing.schemas import ExecutionEditRequest
    from app.core.security import CurrentUser

    database = f"heijin_rebate_date_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
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
                    sql = statement.lower()
                    if ("from orders" in sql and "for update" in sql) or ("from pools" in sql and "for no key update" in sql):
                        reached.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                user = CurrentUser(id=1, username="pytest", roles=("ADMIN",), owner_scope="ALL")
                payload = ExecutionEditRequest.model_validate({"events": [{"id": event_id, "expected_amount": "100", "amount": "100", "occurred_at": "2026-11-02T12:00:00"}]})
                edit_execution_detail(session, order_id, payload, user)
                session.commit()

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            update_rebate(first, rebate_id, note="新备注", actor="pytest")
            future = executor.submit(edit_date)
            assert reached.wait(10), "订单编辑未到达事务锁"
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
def test_reconciliation_and_amount_edit_serialize(v1_engine, concurrency_schema_template, first_action, edit_kind):
    from app.business.orders.events import post_event
    from app.business.shared.order_detail.editing.editor import edit_execution_detail
    from app.business.shared.order_detail.editing.schemas import ExecutionEditRequest
    from app.core.security import CurrentUser
    from app.finance.reconciliation.service import _system_balance_as_of

    database = f"heijin_recon_edit_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
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
            assert future.result(timeout=10) == "accepted"

        with factory() as session:
            recon = session.scalar(select(Reconciliation).where(Reconciliation.pool_id == pool_id))
            snapshot = session.scalar(select(BalanceSnapshot).where(BalanceSnapshot.pool_id == pool_id))
            expected = 200 if first_action == "edit" else 100
            assert recon.system_balance == (expected if edit_kind == "rebate" else -expected)
            assert snapshot.balance == recon.system_balance
            assert _system_balance_as_of(session, pool_id, day) == (200 if edit_kind == "rebate" else -200)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_rebate_edit_and_rejected_reversal_serialize(v1_engine, concurrency_schema_template):
    database = f"heijin_rebate_reverse_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
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
                    run_action(session, "reverse")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            run_action(first, "edit")
            future = executor.submit(second_action)
            try:
                assert reached.wait(10), "第二个操作未到达流水查询"
                first.commit()
            finally:
                proceed.set()
            assert future.result(timeout=10) == "rejected"

        with factory() as session:
            rebate = session.get(RebateRecord, rebate_id)
            action = session.get(OrderEvent, event_id)
            flow = session.get(Cashflow, flow_id)
            reversal = session.scalar(select(Cashflow).where(Cashflow.source_type == "REVERSAL", Cashflow.source_id == flow_no))
            assert [rebate.amount, action.amount, flow.amount] == [200] * 3
            assert reversal is None
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_concurrent_rebate_edits_keep_record_event_and_flow_consistent(v1_engine, concurrency_schema_template):
    database = f"heijin_rebate_concurrency_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
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
def test_concurrent_reconciliation_creation_keeps_one_snapshot(v1_engine, concurrency_schema_template, same_account):
    database = f"heijin_recon_concurrency_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            pool_id = session.scalar(select(Pool.id).where(Pool.code == "pool_01"))
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


@pytest.mark.parametrize("action", ["return", "partial", "loss", "cancel", "edit", "cancel_first", "resolve"])
def test_deposit_and_reconciliation_competing_actions_are_serialized(v1_engine, concurrency_schema_template, action):
    database = f"heijin_fund_concurrency_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
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
                    if action in {"return", "partial", "cancel_first"}:
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
            elif action == "cancel_first":
                cancel_deposit(first, row_id, cancelled_on=day, reason="取消", actor="pytest")
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
            elif action == "cancel_first":
                row = session.get(Deposit, row_id)
                assert row.status == "CANCELLED" and row.returned_amount == 100
                flows = session.scalars(select(Cashflow).where(Cashflow.source_type == "DEPOSIT", Cashflow.source_id == str(row_id))).all()
                assert sorted(flow.category for flow in flows) == ["DEPOSIT_CANCEL", "DEPOSIT_HOLD"]
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


def test_concurrent_transfer_repairs_only_create_one_counterpart(v1_engine, concurrency_schema_template):
    database = f"heijin_repair_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            source = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            target = session.scalar(select(Pool).where(Pool.code == "pool_02"))
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
def test_concurrent_actions_cannot_change_reversed_flow(v1_engine, concurrency_schema_template, action):
    database = f"heijin_cashflow_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
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


def test_concurrent_transfers_remain_paired_with_negative_balance(v1_engine, concurrency_schema_template):
    database = f"heijin_transfer_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            source = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            target = session.scalar(select(Pool).where(Pool.code == "pool_02"))
            source_id, target_id = source.id, target.id
            session.add(Cashflow(flow_no="TEST-CONCURRENT-IN", pool_id=source_id,
                                 occurred_on=date(2026, 11, 1), direction=Direction.IN.value,
                                 accounting_attribute=AccountingAttribute.SELF_REVENUE.value,
                                 category="OTHER", amount=100, created_by="pytest", updated_by="pytest"))
            session.commit()
        ready = Barrier(2, timeout=10)

        def concurrent_transfer(from_id, to_id, amount):
            with factory() as session:
                ready.wait()
                result = create_transfer(session, source_pool_id=from_id, target_pool_id=to_id,
                                         amount=amount, occurred_on=date(2026, 11, 2), actor="pytest")
                session.commit()
                return result["transfer_id"]

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(concurrent_transfer, source_id, target_id, "80")
            second = executor.submit(concurrent_transfer, source_id, target_id, "80")
            transfer_ids = {first.result(timeout=20), second.result(timeout=20)}
        assert len(transfer_ids) == 2

        with factory() as session:
            assert pool_balance(session, source_id)["available"] == -60
            assert pool_balance(session, target_id)["available"] == 160
            rows = session.scalars(select(Cashflow).where(Cashflow.source_id.in_(transfer_ids))).all()
            assert len(rows) == 4
            for transfer_id in transfer_ids:
                pair = [row for row in rows if row.source_id == transfer_id]
                assert {(row.pool_id, row.direction, row.amount) for row in pair} == {
                    (source_id, Direction.OUT.value, 80),
                    (target_id, Direction.IN.value, 80),
                }

        # 反向并发划转同样必须完成，避免不同账户间的锁顺序造成死锁。
        ready = Barrier(2, timeout=10)
        with ThreadPoolExecutor(max_workers=2) as executor:
            forward = executor.submit(concurrent_transfer, source_id, target_id, "10")
            backward = executor.submit(concurrent_transfer, target_id, source_id, "10")
            assert forward.result(timeout=20) != backward.result(timeout=20)

        with factory() as session:
            assert pool_balance(session, source_id)["available"] == -60
            assert pool_balance(session, target_id)["available"] == 160
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_concurrent_default_pool_switches_keep_one_default(v1_engine, concurrency_schema_template):
    from app.settings.field_definitions.pools import create_pool, update_pool

    database = f"heijin_default_pool_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            second = session.scalar(select(Pool).where(Pool.code == "pool_02"))
            third = create_pool(session, name="第三账户", actor="pytest")
            second_id, third_id = second.id, third.id
            session.commit()
        reached, proceed = Event(), Event()

        def switch_second():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    if "pg_advisory_xact_lock" in statement.lower():
                        reached.set()

                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from pools" in sql and "is_default is true" in sql and not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)

                event.listen(session.connection(), "before_cursor_execute", before)
                event.listen(session.connection(), "after_cursor_execute", after)
                update_pool(session, third_id, is_default=True, actor="pytest")
                session.commit()

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            update_pool(first, second_id, is_default=True, actor="pytest")
            future = executor.submit(switch_second)
            try:
                assert reached.wait(10), "第二次默认账户设置未到达并发点"
                first.commit()
            finally:
                proceed.set()
            future.result(timeout=10)

        with factory() as session:
            defaults = session.scalars(select(Pool).where(Pool.is_default.is_(True))).all()
            assert [pool.id for pool in defaults] == [third_id]
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("kind", ["manual", "order_event"])
@pytest.mark.parametrize("first_action", ["disable", "write"])
def test_pool_disable_serializes_with_new_cashflows(v1_engine, concurrency_schema_template, kind, first_action):
    from app.business.orders.events import post_event
    from app.settings.field_definitions.pools import set_pool_status

    database = f"heijin_pool_disable_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            account = create_account(session, game_account="disable-race", business_mode="SELF",
                                     inventory_type="RECOVERY", actor="pytest")
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest", account_id=account.id)
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            pool_id, order_id = pool.id, order.id
            session.commit()
        reached, proceed = Event(), Event()

        def act(session, action):
            if action == "disable":
                set_pool_status(session, pool_id, "DISABLED", actor="pytest")
            elif kind == "manual":
                create_cashflow(session, pool_id=pool_id, occurred_on=day, direction="OUT",
                                category="OTHER", amount="10", actor="pytest")
            else:
                post_event(session, order_id, event_type="BUY", amount="10", occurred_on=day,
                           pool_id=pool_id, actor="pytest")

        def second():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "pg_advisory_xact_lock" in sql or (first_action == "write" and "update pools" in sql):
                        reached.set()

                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if first_action == "disable" and "from pools" in sql and "where pools.id" in sql and not reached.is_set():
                        reached.set()
                        assert proceed.wait(10)

                event.listen(session.connection(), "before_cursor_execute", before)
                event.listen(session.connection(), "after_cursor_execute", after)
                try:
                    act(session, "write" if first_action == "disable" else "disable")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            act(first, first_action)
            future = executor.submit(second)
            try:
                assert reached.wait(10), "并发操作未到达账户校验"
                if first_action == "write":
                    with pytest.raises(FutureTimeout):
                        future.result(timeout=0.3)
                first.commit()
            finally:
                proceed.set()
            assert future.result(timeout=10) == ("rejected" if first_action == "disable" else "accepted")
        with factory() as session:
            assert session.get(Pool, pool_id).status == "DISABLED"
            flows = session.scalars(select(Cashflow).where(Cashflow.pool_id == pool_id)).all()
            assert len(flows) == (0 if first_action == "disable" else 1)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_pool_disable_and_order_cashflow_edit_do_not_deadlock(v1_engine, concurrency_schema_template):
    from app.business.shared.order_detail.editing.editor import edit_execution_detail
    from app.business.shared.order_detail.editing.schemas import ExecutionEditRequest
    from app.core.security import CurrentUser
    from app.settings.field_definitions.pools import set_pool_status

    database = f"heijin_pool_edit_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            account = create_account(session, game_account="pool-edit-race", business_mode="SELF",
                                     inventory_type="RECOVERY", actor="pytest")
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest", account_id=account.id)
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            flow = create_cashflow(session, pool_id=pool.id, occurred_on=day, direction="OUT", category="OTHER",
                                   amount="10", order_id=order.id, actor="pytest")
            pool_id, order_id, flow_no = pool.id, order.id, flow.flow_no
            session.commit()

        row_locked, resume_edit, disable_started, disable_locked = Event(), Event(), Event(), Event()

        def edit():
            with factory() as session:
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from pools" in sql and "for no key update" in sql:
                        row_locked.set()
                        assert resume_edit.wait(10)
                event.listen(session.connection(), "after_cursor_execute", after)
                user = CurrentUser(id=1, username="pytest", roles=("ADMIN",), owner_scope="ALL")
                payload = ExecutionEditRequest.model_validate({"events": [], "cashflows": [{
                    "flow_no": flow_no, "pool_id": pool_id, "note": "并发更正",
                }]})
                edit_execution_detail(session, order_id, payload, user)
                session.commit()

        def disable():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    if "pg_advisory_xact_lock" in statement.lower():
                        disable_started.set()
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    if "pg_advisory_xact_lock" in statement.lower():
                        disable_locked.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                event.listen(session.connection(), "after_cursor_execute", after)
                set_pool_status(session, pool_id, "DISABLED", actor="pytest")
                session.commit()

        with ThreadPoolExecutor(max_workers=2) as executor:
            edit_future = executor.submit(edit)
            try:
                assert row_locked.wait(10), "订单编辑未到达资金账户锁"
                disable_future = executor.submit(disable)
                assert disable_started.wait(10), "停用操作未到达状态锁"
                disable_locked.wait(0.5)
            finally:
                resume_edit.set()
            edit_future.result(timeout=10)
            disable_future.result(timeout=10)

        with factory() as session:
            assert session.get(Pool, pool_id).status == "DISABLED"
            assert session.scalar(select(Cashflow).where(Cashflow.flow_no == flow_no)).note == "并发更正"
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_order_date_shift_and_new_deposit_keep_matching_dates(v1_engine, concurrency_schema_template):
    from app.business.orders.mutations import update_order

    database = f"heijin_order_deposit_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        old_day, new_day = date(2026, 11, 1), date(2026, 11, 11)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            order = create_order(session, order_type="HS", trade_date=old_day, actor="pytest")
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            order_id, pool_id = order.id, pool.id
            session.commit()

        deposits_read, resume_shift, writer_reached = Event(), Event(), Event()

        def shift():
            with factory() as session:
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from deposits" in sql and "for update" in sql:
                        deposits_read.set()
                        assert resume_shift.wait(10)
                event.listen(session.connection(), "after_cursor_execute", after)
                update_order(session, order_id, trade_date=new_day, actor="pytest")
                session.commit()

        def create():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "insert into deposits" in sql or ("from orders" in sql and "for update" in sql):
                        writer_reached.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                create_deposit(session, pool_id=pool_id, amount="50", paid_on=old_day,
                               source_order_id=order_id, actor="pytest")
                session.commit()

        with ThreadPoolExecutor(max_workers=2) as executor:
            shift_future = executor.submit(shift)
            try:
                assert deposits_read.wait(10), "订单日期更新未到达押金查询"
                create_future = executor.submit(create)
                assert writer_reached.wait(10), "押金登记未到达并发点"
                try:
                    create_future.result(timeout=0.5)
                except FutureTimeout:
                    pass
            finally:
                resume_shift.set()
            shift_future.result(timeout=10)
            create_future.result(timeout=10)

        with factory() as session:
            deposit = session.scalar(select(Deposit).where(Deposit.source_order_id == order_id))
            flow = session.scalar(select(Cashflow).where(Cashflow.source_type == "DEPOSIT", Cashflow.source_id == str(deposit.id)))
            assert deposit.paid_on == flow.occurred_on
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_order_date_shift_and_deposit_return_do_not_deadlock(v1_engine, concurrency_schema_template):
    from app.business.orders.mutations import update_order

    database = f"heijin_order_return_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        old_day, new_day = date(2026, 11, 1), date(2026, 11, 11)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            order = create_order(session, order_type="HS", trade_date=old_day, actor="pytest")
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            deposit = create_deposit(session, pool_id=pool.id, amount="50", paid_on=old_day,
                                     source_order_id=order.id, actor="pytest")
            order_id, deposit_id = order.id, deposit.id
            session.commit()

        return_locked, resume_return, shift_started = Event(), Event(), Event()

        def release():
            with factory() as session:
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from deposits" in sql and "for update" in sql:
                        return_locked.set()
                        assert resume_return.wait(10)
                event.listen(session.connection(), "after_cursor_execute", after)
                return_deposit(session, deposit_id, amount="20", released_on=old_day, actor="pytest")
                session.commit()

        def shift():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if ("from deposits" in sql and "for update" in sql) or ("from orders" in sql and "for update" in sql):
                        shift_started.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                update_order(session, order_id, trade_date=new_day, actor="pytest")
                session.commit()

        with ThreadPoolExecutor(max_workers=2) as executor:
            return_future = executor.submit(release)
            try:
                assert return_locked.wait(10), "押金退还未到达记录锁"
                shift_future = executor.submit(shift)
                assert shift_started.wait(10), "订单日期更新未开始加锁"
                try:
                    shift_future.result(timeout=0.5)
                except FutureTimeout:
                    pass
            finally:
                resume_return.set()
            return_future.result(timeout=10)
            shift_future.result(timeout=10)

        with factory() as session:
            deposit = session.get(Deposit, deposit_id)
            flows = session.scalars(select(Cashflow).where(Cashflow.source_type == "DEPOSIT", Cashflow.source_id == str(deposit_id))).all()
            assert deposit.paid_on == deposit.released_on == new_day
            assert {flow.occurred_on for flow in flows} == {new_day}
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_order_date_shift_keeps_concurrent_rebate_date_edit(v1_engine, concurrency_schema_template):
    from datetime import timedelta
    from app.business.orders.mutations import update_order

    database = f"heijin_order_rebate_shift_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        old_day, new_day = date(2026, 11, 1), date(2026, 11, 11)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            order = create_order(session, order_type="HS", trade_date=old_day, actor="pytest")
            rebate = create_rebate(session, source_order_id=order.id, rebate_type="BUY", amount="10",
                                   collected_on=old_day, actor="pytest")
            order_id, rebate_id, rebate_no = order.id, rebate.id, rebate.rebate_no
            session.commit()

        shift_started, flow_update_attempted = Event(), Event()

        def shift():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from orders" in sql and "for update" in sql:
                        shift_started.set()
                    if "update cashflow" in sql:
                        flow_update_attempted.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                update_order(session, order_id, trade_date=new_day, actor="pytest")
                session.commit()

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            update_rebate(first, rebate_id, collected_on=old_day + timedelta(days=1), actor="pytest")
            future = executor.submit(shift)
            assert shift_started.wait(10), "订单日期更新未开始加锁"
            flow_update_attempted.wait(0.5)
            first.commit()
            future.result(timeout=10)

        with factory() as session:
            rebate = session.get(RebateRecord, rebate_id)
            action = session.scalar(select(OrderEvent).where(OrderEvent.source_type == "REBATE", OrderEvent.source_id == rebate_no))
            flow = session.scalar(select(Cashflow).where(Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == action.event_no))
            assert rebate.collected_on == action.occurred_on == flow.occurred_on == new_day + timedelta(days=1)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_order_date_shift_and_cashflow_reversal_do_not_deadlock(v1_engine, concurrency_schema_template):
    from app.business.orders.mutations import update_order

    database = f"heijin_order_reverse_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        old_day, new_day = date(2026, 11, 1), date(2026, 11, 11)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            order = create_order(session, order_type="HS", trade_date=old_day, actor="pytest")
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            flow = create_cashflow(session, pool_id=pool.id, order_id=order.id, amount="50", occurred_on=old_day,
                                   direction="OUT", category="OTHER", actor="pytest")
            order_id, flow_id, flow_no = order.id, flow.id, flow.flow_no
            session.commit()

        flow_locked, resume_reverse, shift_started = Event(), Event(), Event()

        def reverse():
            with factory() as session:
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from cashflow" in sql and "for update" in sql:
                        flow_locked.set()
                        assert resume_reverse.wait(10)
                event.listen(session.connection(), "after_cursor_execute", after)
                reverse_cashflow(session, flow_id, reversed_on=old_day, reason="更正", actor="pytest")
                session.commit()

        def shift():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "from orders" in sql and "for update" in sql:
                        shift_started.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                update_order(session, order_id, trade_date=new_day, actor="pytest")
                session.commit()

        with ThreadPoolExecutor(max_workers=2) as executor:
            reverse_future = executor.submit(reverse)
            try:
                assert flow_locked.wait(10), "流水冲销未到达记录锁"
                shift_future = executor.submit(shift)
                assert shift_started.wait(10), "订单日期更新未开始加锁"
                try:
                    shift_future.result(timeout=0.5)
                except FutureTimeout:
                    pass
            finally:
                resume_reverse.set()
            reverse_future.result(timeout=10)
            shift_future.result(timeout=10)

        with factory() as session:
            flows = session.scalars(select(Cashflow).where(Cashflow.order_id == order_id)).all()
            assert len(flows) == 2
            assert {flow.occurred_on for flow in flows} == {new_day}
            assert any(flow.source_type == "REVERSAL" and flow.source_id == flow_no for flow in flows)
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("kind", ["manual", "deposit"])
def test_order_write_and_pool_disable_keep_consistent_lock_order(v1_engine, concurrency_schema_template, kind):
    from app.domain.trade import Order
    from app.settings.field_definitions.pools import assert_pool_usable, set_pool_status

    database = f"heijin_order_pool_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=5)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest")
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            order_id, pool_id = order.id, pool.id
            session.commit()

        order_locked, resume_order = Event(), Event()
        writer_started, writer_has_pool, disable_started = Event(), Event(), Event()

        def edit_order():
            with factory() as session:
                session.get(Order, order_id, with_for_update=True)
                order_locked.set()
                assert resume_order.wait(10)
                try:
                    assert_pool_usable(session, pool_id)
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        def write():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    sql = statement.lower()
                    if "pg_advisory_xact_lock_shared" in sql or ("from orders" in sql and "for key share" in sql):
                        writer_started.set()
                def after(_conn, _cursor, statement, _parameters, _context, _many):
                    if "pg_advisory_xact_lock_shared" in statement.lower():
                        writer_has_pool.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                event.listen(session.connection(), "after_cursor_execute", after)
                try:
                    if kind == "manual":
                        create_cashflow(session, pool_id=pool_id, order_id=order_id, amount="10", occurred_on=day,
                                        direction="OUT", category="OTHER", actor="pytest")
                    else:
                        create_deposit(session, pool_id=pool_id, source_order_id=order_id, amount="10", paid_on=day, actor="pytest")
                    session.commit()
                    return "accepted"
                except Validation:
                    session.rollback()
                    return "rejected"

        def disable():
            with factory() as session:
                def before(_conn, _cursor, statement, _parameters, _context, _many):
                    if "pg_advisory_xact_lock(" in statement.lower():
                        disable_started.set()
                event.listen(session.connection(), "before_cursor_execute", before)
                set_pool_status(session, pool_id, "DISABLED", actor="pytest")
                session.commit()

        with ThreadPoolExecutor(max_workers=3) as executor:
            edit_future = executor.submit(edit_order)
            try:
                assert order_locked.wait(10), "订单编辑未取得订单锁"
                write_future = executor.submit(write)
                assert writer_started.wait(10), "关联流水登记未开始加锁"
                writer_has_pool.wait(0.5)
                disable_future = executor.submit(disable)
                assert disable_started.wait(10), "账户停用未开始加锁"
                try:
                    disable_future.result(timeout=0.5)
                except FutureTimeout:
                    pass
            finally:
                resume_order.set()
            edit_future.result(timeout=10)
            write_future.result(timeout=10)
            disable_future.result(timeout=10)

        with factory() as session:
            assert session.get(Pool, pool_id).status == "DISABLED"
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


def test_reconciliation_sees_one_committed_order_date_shift(v1_engine, concurrency_schema_template):
    from datetime import timedelta
    from app.business.orders.mutations import update_order
    from app.finance.reconciliation.service import _system_balance_as_of

    database = f"heijin_shift_recon_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}" TEMPLATE "{concurrency_schema_template}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        factory = sessionmaker(bind=engine, autoflush=False)
        day = date(2026, 11, 1)
        cutoff, new_day = day + timedelta(days=5), day + timedelta(days=10)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            order = create_order(session, order_type="HS", trade_date=day, actor="pytest")
            pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
            for direction, amount in (("OUT", "100"), ("IN", "50")):
                create_cashflow(session, pool_id=pool.id, order_id=order.id, amount=amount, occurred_on=day,
                                direction=direction, category="OTHER", actor="pytest")
            order_id, pool_id = order.id, pool.id
            session.commit()

        with factory() as shifting, factory() as reconciling:
            update_order(shifting, order_id, trade_date=new_day, actor="pytest")
            recon = create_reconciliation(reconciling, pool_id=pool_id, reconciled_on=cutoff,
                                          account_label="并发快照", statement_balance="0", reason="核对", actor="pytest")
            assert recon.system_balance == -50
            recon_id = recon.id
            shifting.commit()
            reconciling.commit()
        with factory() as session:
            snapshot = session.scalar(select(BalanceSnapshot).where(BalanceSnapshot.reconciliation_id == recon_id))
            assert snapshot.balance == session.get(Reconciliation, recon_id).system_balance == -50
            assert _system_balance_as_of(session, pool_id, cutoff) == 0
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()
