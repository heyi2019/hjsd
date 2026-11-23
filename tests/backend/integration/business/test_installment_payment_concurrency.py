"""INSTALLMENT-03 分期资金及处置并发操作保持一致。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select, text, update
from sqlalchemy.orm import sessionmaker

from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.core.errors import AppError
from app.domain.base import Base
from app.domain.trade import Cashflow, Installment
from app.domain.users import User
from app.business.installments.create import create_installment
from app.business.installments.repayments.cancel import cancel_installment
from app.business.installments.repayments.pay import pay
from app.business.installments.repayments.waive import waive_schedule
from app.business.installments.recovery import mark_overdue, recover_account
from app.settings.field_definitions.seeds import seed_foundation

pytestmark = pytest.mark.db


def test_concurrent_operator_edits_record_the_serialized_previous_value(v1_engine):
    from app.business.installments.routers.schedules_router import update_installment_operation_operators
    from app.business.installments.schemas import OperationOperatorsUpdateIn
    from app.core.security import DEV_USERS
    from app.domain.foundation import AuditLog, BusinessOperationOperator

    database = f"heijin_installment_test_{uuid4().hex}"
    admin_engine = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            users = [User(username=name, display_name=name, password_hash="test", role="ADMIN",
                          owner_scope="ALL", pool_ids=[], team_ids=[], is_active=True)
                     for name in ("pytest", "first", "second")]
            session.add_all(users)
            session.flush()
            order = create_order(session, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="PICKUP_SALE",
                                          principal="100", down_payment="0", periods=1,
                                          per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract_id, contract_no = contract.id, contract.inst_no
            original_id, first_id, second_id = [user.id for user in users]
            session.commit()
        waiting = Event()

        def second_update():
            with factory() as session:
                connection = session.connection()
                def observe(_conn, _cursor, statement, _parameters, _context, _many):
                    if "for update" in statement.lower() and "installments" in statement.lower():
                        waiting.set()
                event.listen(connection, "before_cursor_execute", observe)
                update_installment_operation_operators(
                    contract_id, "CREATE", OperationOperatorsUpdateIn(operator_user_ids=[second_id]),
                    db=session, user=DEV_USERS["admin"],
                )
                session.commit()

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            update_installment_operation_operators(
                contract_id, "CREATE", OperationOperatorsUpdateIn(operator_user_ids=[first_id]),
                db=first, user=DEV_USERS["admin"],
            )
            future = executor.submit(second_update)
            assert waiting.wait(10)
            assert not future.done()
            first.commit()
            future.result(timeout=10)
        with factory() as session:
            operation = session.scalar(select(BusinessOperationOperator).where(
                BusinessOperationOperator.entity_type == "installment",
                BusinessOperationOperator.entity_id == contract_no,
                BusinessOperationOperator.operation_key == "CREATE",
            ))
            audit = session.scalars(select(AuditLog).where(
                AuditLog.entity_type == "installment_operation_operators",
                AuditLog.entity_id == f"{contract_no}:CREATE",
            ).order_by(AuditLog.id)).all()
            assert operation.operator_user_ids == [second_id]
            assert [(row.before_json["operator_user_ids"], row.after_json["operator_user_ids"]) for row in audit] == [
                ([original_id], [first_id]), ([first_id], [second_id]),
            ]
    finally:
        engine.dispose()
        with admin_engine.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}" WITH (FORCE)')
        admin_engine.dispose()


def test_installment_payment_and_cancellation_are_serialized(v1_engine):
    database = f"heijin_installment_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            session.add(User(username="pytest", display_name="pytest", password_hash="test", role="ADMIN", owner_scope="ALL", pool_ids=[], team_ids=[], is_active=True))
            session.flush()
            order = create_order(session, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="PICKUP_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract_id = contract.id
            session.commit()
        waiting = Event()
        errors = []
        payment_amount = "100"

        def second_payment():
            with factory() as session:
                session.get(Installment, contract_id)
                connection = session.connection()
                def observe(_conn, _cursor, statement, _parameters, _context, _executemany):
                    sql = statement.lower()
                    if ("for update" in sql and "installments" in sql) or ("update document_sequences" in sql):
                        waiting.set()
                event.listen(connection, "before_cursor_execute", observe)
                try:
                    pay(session, contract_id, amount=payment_amount, paid_on=date(2026, 11, 2), period_no=1, actor="pytest")
                    session.commit()
                    return "accepted"
                except AppError as exc:
                    errors.append(str(exc))
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            pay(first, contract_id, amount="100", paid_on=date(2026, 11, 2), period_no=1, actor="pytest")
            future = executor.submit(second_payment)
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == "rejected"
        with factory() as session:
            contract = session.get(Installment, contract_id)
            flows = session.scalars(select(Cashflow).where(Cashflow.source_type == "INSTALLMENT", Cashflow.source_id == contract.inst_no)).all()
            assert len(flows) == 1 and contract.paid_amount == 100

        with factory() as session:
            order = create_order(session, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="PICKUP_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract_id = contract.id
            session.commit()
        waiting.clear()
        with factory() as cancelling, ThreadPoolExecutor(max_workers=1) as executor:
            cancel_installment(cancelling, contract_id, cancelled_on=date(2026, 11, 2), actor="pytest", reason="取消交易")
            future = executor.submit(second_payment)
            assert waiting.wait(10)
            cancelling.commit()
            assert future.result(timeout=10) == "rejected"
        with factory() as session:
            contract = session.get(Installment, contract_id)
            flows = session.scalars(select(Cashflow).where(Cashflow.source_type == "INSTALLMENT", Cashflow.source_id == contract.inst_no)).all()
            assert contract.status == "CANCELLED" and not flows

        with factory() as session:
            order = create_order(session, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="PICKUP_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract_id = contract.id
            session.commit()
        waiting.clear()

        def cancel_after_payment():
            with factory() as session:
                session.get(Installment, contract_id)
                connection = session.connection()
                def observe(_conn, _cursor, statement, _parameters, _context, _executemany):
                    sql = statement.lower()
                    if ("for update" in sql and "installments" in sql) or "update installments" in sql or "update orders" in sql:
                        waiting.set()
                event.listen(connection, "before_cursor_execute", observe)
                result = cancel_installment(session, contract_id, cancelled_on=date(2026, 11, 2), actor="pytest", reason="取消交易")
                session.commit()
                return result["refund_amount"]

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            pay(first, contract_id, amount="50", paid_on=date(2026, 11, 2), period_no=1, actor="pytest")
            future = executor.submit(cancel_after_payment)
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == 50

        with factory() as session:
            order = create_order(session, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="PICKUP_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract_id = contract.id
            session.commit()
        waiting.clear()

        def waive_after_payment():
            with factory() as session:
                connection = session.connection()
                def observe(_conn, _cursor, statement, _parameters, _context, _executemany):
                    sql = statement.lower()
                    if ("for update" in sql and "installments" in sql) or "update installment_schedules" in sql:
                        waiting.set()
                event.listen(connection, "before_cursor_execute", observe)
                try:
                    waive_schedule(session, contract_id, period_no=1, amount="60", waived_on=date(2026, 11, 2), actor="pytest", reason="减免")
                    session.commit()
                    return "accepted"
                except AppError:
                    session.rollback()
                    return "rejected"

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            pay(first, contract_id, amount="50", paid_on=date(2026, 11, 2), period_no=1, actor="pytest")
            future = executor.submit(waive_after_payment)
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == "rejected"

        with factory() as session:
            order = create_order(session, order_type="HS", trade_date=date(2026, 11, 1), actor="pytest", account_snapshot={"game_account": "concurrent-recovery", "game_type": "王者荣耀"})
            post_event(session, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="STOCK_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract.status = "OVERDUE"
            contract_id = contract.id
            session.commit()
        waiting.clear()

        def recover_after_payment():
            with factory() as session:
                connection = session.connection()
                def observe(_conn, _cursor, statement, _parameters, _context, _executemany):
                    sql = statement.lower()
                    if ("for update" in sql and "installments" in sql) or "update installments" in sql or "update accounts" in sql:
                        waiting.set()
                event.listen(connection, "before_cursor_execute", observe)
                recover_account(session, contract_id, occurred_on=date(2026, 11, 2), actor="pytest", note="违约回收", recovery_cost=0)
                amount = session.get(Installment, contract_id).bad_debt_amount
                session.commit()
                return amount

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            pay(first, contract_id, amount="50", paid_on=date(2026, 11, 2), period_no=1, actor="pytest")
            future = executor.submit(recover_after_payment)
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == 50

        with factory() as session:
            order = create_order(session, order_type="HS", trade_date=date(2026, 11, 1), actor="pytest", account_snapshot={"game_account": "recovered-no-payment", "game_type": "王者荣耀"})
            post_event(session, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="STOCK_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract.status = "OVERDUE"
            contract_id = contract.id
            session.commit()
        waiting.clear()
        payment_amount = "50"
        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            recover_account(first, contract_id, occurred_on=date(2026, 11, 2), actor="pytest", note="违约回收", recovery_cost=0)
            future = executor.submit(second_payment)
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == "rejected"
            assert "不可收款" in errors[-1]
        with factory() as session:
            contract = session.get(Installment, contract_id)
            assert contract.status == "CLOSED" and contract.paid_amount == 0 and contract.bad_debt_amount == 100

        with factory() as session:
            session.execute(update(Installment).where(Installment.status.in_(["PENDING", "ACTIVE", "OVERDUE"])).values(status="CANCELLED"))
            order = create_order(session, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="PICKUP_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract_id = contract.id
            session.commit()
        waiting.clear()

        def mark_after_payment():
            with factory() as session:
                connection = session.connection()
                def observe(_conn, _cursor, statement, _parameters, _context, _executemany):
                    sql = statement.lower()
                    if ("for update" in sql and "installments" in sql) or "update installment_schedules" in sql or "update installments" in sql:
                        waiting.set()
                event.listen(connection, "before_cursor_execute", observe)
                count = mark_overdue(session, as_of=date(2027, 1, 2), actor="pytest")
                session.commit()
                return count

        with factory() as first, ThreadPoolExecutor(max_workers=1) as executor:
            pay(first, contract_id, amount="100", paid_on=date(2026, 11, 2), period_no=1, actor="pytest")
            future = executor.submit(mark_after_payment)
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == 0
        with factory() as session:
            contract = session.get(Installment, contract_id)
            assert contract.status == "SETTLED" and contract.paid_amount == 100

        with factory() as session:
            order = create_order(session, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest")
            contract = create_installment(session, order_id=order.id, contract_type="PICKUP_SALE", principal="100", down_payment="0", periods=1, per_period="100", first_due_on=date(2026, 11, 1), actor="pytest")
            contract_id = contract.id
            session.commit()
        waiting.clear()
        payment_amount = "100"
        with factory() as marking, ThreadPoolExecutor(max_workers=1) as executor:
            assert mark_overdue(marking, as_of=date(2027, 1, 2), actor="pytest") == 1
            future = executor.submit(second_payment)
            assert waiting.wait(10)
            marking.commit()
            assert future.result(timeout=10) == "accepted"
        with factory() as session:
            contract = session.get(Installment, contract_id)
            assert contract.status == "SETTLED" and contract.paid_amount == 100
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE "{database}"'))
        admin.dispose()
