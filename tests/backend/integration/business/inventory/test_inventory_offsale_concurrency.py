"""INVENTORY-04 库存下架并发操作保持原子性。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Barrier, Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app.business.orders import schemas
from app.business.shared.operations.consignment import register_consignment
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.business.orders.routers.order_events_router import inventory_offsale
from app.core.errors import AppError
from app.core.security import DEV_USERS
from app.domain.base import Base
from app.domain.trade import Account, OrderEvent
from app.settings.field_definitions.seeds import seed_foundation

pytestmark = pytest.mark.db


def test_simultaneous_offsale_has_one_result(v1_engine):
    # 专用临时库：会话提交真实生效，两条线程各自持有独立连接。
    database_name = f"heijin_offsale_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database_name}"')
    engine = create_engine(v1_engine.url.set(database=database_name), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.commit()
        for order_type in ("DG", "HS"):
            with factory() as session:
                order = create_order(session, order_type=order_type, trade_date=date(2026, 11, 1),
                    actor="pytest", account_snapshot={"game_account": f"concurrent-{order_type}", "game_type": "王者荣耀"})
                buy = None
                if order_type == "HS":
                    buy, _ = post_event(session, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
                register_consignment(session, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
                    form_extra={"consignment_platforms": ["测试平台"]})
                payload = schemas.InventoryOffsaleIn(reason="出库", occurred_on=date(2026, 11, 2),
                    unlisted_at="2026-11-02T12:00", amount="100" if buy else None,
                    pool_id=buy.pool_id if buy else None, offset_event_id=buy.id if buy else None)
                order_id = order.id
                session.commit()
            barrier = Barrier(2, timeout=10)

            def worker(_):
                with factory() as session:
                    barrier.wait()
                    try:
                        inventory_offsale(order_id, payload, session, DEV_USERS["admin"])
                        session.commit()
                        return "success"
                    except AppError:
                        session.rollback()
                        return "rejected"

            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(worker, range(2)))
            assert sorted(results) == ["rejected", "success"]
            with factory() as session:
                events = session.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
                assert sum((event.form_extra or {}).get("operation_type") == "UNLIST" for event in events) == 1
                if order_type == "HS":
                    assert sum(event.event_type == "CANCEL" for event in events) == 1

        for order_type in ("DG", "HS"):
            with factory() as session:
                order = create_order(session, order_type=order_type, trade_date=date(2026, 11, 1),
                    actor="pytest", account_snapshot={"game_account": f"listing-race-{order_type}", "game_type": "王者荣耀"})
                buy = None
                if order_type == "HS":
                    buy, _ = post_event(session, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
                payload = schemas.InventoryOffsaleIn(reason="出库", occurred_on=date(2026, 11, 2),
                    unlisted_at="2026-11-02T12:00", amount="100" if buy else None,
                    pool_id=buy.pool_id if buy else None, offset_event_id=buy.id if buy else None)
                order_id, account_id = order.id, order.account_id
                session.commit()

            started = Event()
            def register_after_offsale_starts():
                with factory() as session:
                    connection = session.connection()
                    def observe_lock(_conn, _cursor, statement, _parameters, _context, _executemany):
                        if "FOR UPDATE" in statement.upper() and "orders" in statement.lower():
                            started.set()
                    event.listen(connection, "before_cursor_execute", observe_lock)
                    try:
                        register_consignment(session, order_id, occurred_on=date(2026, 11, 2), actor="pytest",
                            form_extra={"consignment_platforms": ["并发平台"]})
                        session.commit()
                        return "success"
                    except AppError:
                        session.rollback()
                        return "rejected"

            with factory() as offsale_session, ThreadPoolExecutor(max_workers=1) as executor:
                inventory_offsale(order_id, payload, offsale_session, DEV_USERS["admin"])
                future = executor.submit(register_after_offsale_starts)
                assert started.wait(10)
                offsale_session.commit()
                assert future.result(timeout=10) == "rejected"
            with factory() as session:
                assert session.get(Account, account_id).status == "VOID"
                events = session.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
                assert not any((event.form_extra or {}).get("consignment_platforms") == ["并发平台"] for event in events)

        for order_type in ("DG", "HS"):
            with factory() as session:
                order = create_order(session, order_type=order_type, trade_date=date(2026, 11, 1),
                    actor="pytest", account_snapshot={"game_account": f"listing-first-{order_type}", "game_type": "王者荣耀"})
                buy = None
                if order_type == "HS":
                    buy, _ = post_event(session, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
                payload = schemas.InventoryOffsaleIn(reason="出库", occurred_on=date(2026, 11, 2),
                    unlisted_at="2026-11-02T12:00", amount="100" if buy else None,
                    pool_id=buy.pool_id if buy else None, offset_event_id=buy.id if buy else None)
                order_id = order.id
                session.commit()
            started = Event()
            def offsale_after_listing_starts():
                with factory() as session:
                    connection = session.connection()
                    def observe_lock(_conn, _cursor, statement, _parameters, _context, _executemany):
                        if "FOR UPDATE" in statement.upper() and "orders" in statement.lower():
                            started.set()
                    event.listen(connection, "before_cursor_execute", observe_lock)
                    inventory_offsale(order_id, payload, session, DEV_USERS["admin"])
                    session.commit()
            with factory() as listing_session, ThreadPoolExecutor(max_workers=1) as executor:
                register_consignment(listing_session, order_id, occurred_on=date(2026, 11, 2), actor="pytest",
                    form_extra={"consignment_platforms": ["先上架平台"]})
                future = executor.submit(offsale_after_listing_starts)
                assert started.wait(10)
                listing_session.commit()
                future.result(timeout=10)
            with factory() as session:
                events = session.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
                listings = [e for e in events if (e.form_extra or {}).get("operation_type") == "CONSIGNMENT"]
                unlistings = [e for e in events if (e.form_extra or {}).get("operation_type") == "UNLIST"]
                assert len(listings) == len(unlistings) == 1
                assert unlistings[0].form_extra["consignment_event_id"] == listings[0].id

        with factory() as session:
            order = create_order(session, order_type="DG", trade_date=date(2026, 11, 1), actor="pytest",
                account_snapshot={"game_account": "concurrent-duplicate-listing", "game_type": "王者荣耀"})
            order_id = order.id
            session.commit()
        barrier = Barrier(2, timeout=10)
        def duplicate_listing_worker(_):
            with factory() as session:
                barrier.wait()
                try:
                    register_consignment(session, order_id, occurred_on=date(2026, 11, 2), actor="pytest",
                        form_extra={"consignment_platforms": ["同一平台"]})
                    session.commit()
                    return "success"
                except AppError:
                    session.rollback()
                    return "rejected"
        with ThreadPoolExecutor(max_workers=2) as executor:
            assert sorted(executor.map(duplicate_listing_worker, range(2))) == ["rejected", "success"]
        with factory() as session:
            events = session.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
            assert sum((item.form_extra or {}).get("operation_type") == "CONSIGNMENT" for item in events) == 1
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database_name}"')
        admin.dispose()
