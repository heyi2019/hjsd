"""REVERSAL-02 同一笔流水的冲销、编辑和删除必须串行检查。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app.core.errors import AppError
from app.domain.base import Base
from app.domain.foundation import Pool
from app.domain.trade import Cashflow
from app.funds.cashflows import create_cashflow, delete_cashflow, reverse_cashflow, update_cashflow
from app.settings.field_definitions.seeds import seed_foundation

pytestmark = pytest.mark.db


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
