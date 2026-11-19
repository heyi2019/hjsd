from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Event
from uuid import uuid4

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import sessionmaker

from app.business.create import create_order
from app.core.errors import AppError
from app.domain.base import Base
from app.domain.trade import Cashflow, Installment
from app.domain.users import User
from app.funds.installments.create import create_installment
from app.funds.installments.repayments.cancel import cancel_installment
from app.funds.installments.repayments.pay import pay
from app.funds.installments.repayments.waive import waive_schedule
from app.settings.field_definitions.seeds import seed_foundation


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
                    pay(session, contract_id, amount="100", paid_on=date(2026, 11, 2), period_no=1, actor="pytest")
                    session.commit()
                    return "accepted"
                except AppError:
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
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE "{database}"'))
        admin.dispose()
