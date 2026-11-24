"""API-01 通知读写规则与库存提醒。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
import base64
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.notifications import Notification
from app.domain.trade import Account, Order
from app.domain.users import User
from app.workbench.notifications import query as notification_query
from app.workbench.notifications import service as notification_service
from app.business.orders.create import create_order
from app.business.orders.events import post_event

pytestmark = pytest.mark.db


def _make_unread(seeded_db, **kwargs):
    return notification_service.create_notification(
        seeded_db,
        recipient_user_id=kwargs.get("recipient_user_id", 2),
        notification_type=kwargs.get("notification_type", "SYSTEM"),
        title=kwargs.get("title", "测试通知"),
        message=kwargs.get("message", "内容"),
        entity_type=kwargs.get("entity_type", "rebate"),
        entity_id=kwargs.get("entity_id", "RB-1"),
        actor="pytest",
    )


def test_inventory_reminder_uses_default_for_noncanonical_or_out_of_range_days(seeded_db):
    from app.domain.options import OptionSet
    from app.workbench.reminder_config import REMINDER_CODE, read_reminder_config

    setting = seeded_db.scalar(select(OptionSet).where(OptionSet.code == REMINDER_CODE))
    if setting is None:
        setting = OptionSet(code=REMINDER_CODE, label="业务提醒", group="BUSINESS", editable=False, options=[])
        seeded_db.add(setting)
    for value, expected in [
        ("1", 1), ("014", 14), ("365", 365), ("0" * 5000 + "1", 1),
        ("0", 7), ("366", 7), ("1e2", 7), ("1.0", 7), ("+14", 7),
        (" 14 ", 7), ("1\n", 7), ("１４", 7), ("9" * 5000, 7),
    ]:
        setting.options = [{"value": "inventory_aging_days", "label": value}]
        seeded_db.flush()
        assert read_reminder_config(seeded_db)["inventory_aging_days"] == expected, value


def test_create_notification_rejects_blank_title_or_message(seeded_db):
    with pytest.raises(Validation, match="通知标题和内容不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="   ", message="m", entity_type="e", entity_id="1",
        )
    with pytest.raises(Validation, match="通知标题和内容不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="t", message="\n", entity_type="e", entity_id="1",
        )


def test_create_notification_rejects_blank_entity(seeded_db):
    with pytest.raises(Validation, match="通知来源对象不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="t", message="m", entity_type="  ", entity_id="1",
        )
    with pytest.raises(Validation, match="通知来源对象不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="t", message="m", entity_type="e", entity_id="  ",
        )


def test_list_notifications_unread_only_filters(seeded_db, seeded_client):
    a = _make_unread(seeded_db, entity_id="A")
    b = _make_unread(seeded_db, entity_id="B")
    notification_service.mark_read_batch(seeded_db, [a.id], recipient_user_id=2, actor="pytest")
    unread, cursor = notification_query.inbox_page(seeded_db, recipient_user_id=2, category="latest", cursor=None, limit=10)
    assert [n.id for n in unread] == [b.id]
    assert cursor is None
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1)
    profit = {"recipient_user_id": 1, "entity_type": "order", "entity_id": order.order_no}
    first = _make_unread(seeded_db, notification_type="PROFIT_PENDING", **profit)
    second = _make_unread(seeded_db, notification_type="PROFIT_ALLOCATED", **profit)
    third = _make_unread(seeded_db, notification_type="PROFIT_PENDING", **profit)
    fourth = _make_unread(seeded_db, notification_type="PROFIT_PENDING", **profit)
    notification_service.mark_read_batch(seeded_db, [second.id], recipient_user_id=1, actor="pytest")
    headers = {"X-Dev-User": "admin"}
    page = seeded_client.get("/api/notifications/inbox", params={"category": "sale", "limit": 2}, headers=headers)
    assert page.status_code == 200
    result = page.json()
    assert [item["id"] for item in result["items"]] == [fourth.id, third.id]
    assert result["next_cursor"]
    notification_service.mark_read_batch(seeded_db, [fourth.id, first.id], recipient_user_id=1, actor="pytest")
    page = seeded_client.get("/api/notifications/inbox", params={"category": "sale", "limit": 2, "cursor": result["next_cursor"]}, headers=headers)
    assert [item["id"] for item in page.json()["items"]] == [first.id, second.id]
    assert page.json()["next_cursor"] is None
    latest = seeded_client.get("/api/notifications/inbox", params={"category": "latest"}, headers=headers)
    assert [item["id"] for item in latest.json()["items"]] == [third.id]
    invalid_cursor = base64.urlsafe_b64encode(json.dumps({"category": "latest", "phase": "read", "snapshot": "2026-11-21T00:00:00", "time": "2026-11-21T00:00:00", "id": 1}).encode()).decode()
    invalid = seeded_client.get("/api/notifications/inbox", params={"category": "latest", "cursor": invalid_cursor}, headers=headers)
    assert invalid.status_code == 422
    batch = [_make_unread(seeded_db, notification_type="PROFIT_PENDING", **profit) for _ in range(3)]
    first_page = seeded_client.get("/api/notifications/inbox", params={"category": "sale", "limit": 1}, headers=headers).json()
    assert first_page["items"][0]["id"] == batch[2].id
    notification_service.mark_read_batch(seeded_db, [batch[1].id], recipient_user_id=1, actor="pytest")
    second_page = seeded_client.get("/api/notifications/inbox", params={"category": "sale", "limit": 1, "cursor": first_page["next_cursor"]}, headers=headers).json()
    assert second_page["items"][0]["id"] == batch[1].id
    third_page = seeded_client.get("/api/notifications/inbox", params={"category": "sale", "limit": 1, "cursor": second_page["next_cursor"]}, headers=headers).json()
    assert third_page["items"][0]["id"] == batch[0].id


def test_notification_cursor_keeps_later_unread_after_previous_page_is_read(seeded_db):
    rows = [_make_unread(seeded_db, notification_type="PROFIT_ALLOCATED", entity_type="order", entity_id=str(i)) for i in range(3)]
    other = _make_unread(seeded_db, notification_type="PROFIT_ALLOCATED", entity_type="other")
    seeded_db.delete(other)
    seeded_db.flush()
    first, cursor = notification_query.inbox_page(seeded_db, recipient_user_id=2, category="sale", cursor=None, limit=2)
    assert [item.id for item in first] == [rows[2].id, rows[1].id]
    notification_service.mark_read_batch(seeded_db, [item.id for item in first], recipient_user_id=2, actor="pytest")
    second, _ = notification_query.inbox_page(seeded_db, recipient_user_id=2, category="sale", cursor=cursor, limit=2)
    assert [item.id for item in second] == [rows[0].id]
    for row in rows:
        row.read_at = None
    rows[0].created_at = datetime(2026, 11, 22, 10)
    rows[1].created_at = datetime(2026, 11, 21, 10)
    rows[2].created_at = datetime(2026, 11, 21, 10)
    seeded_db.flush()
    first, cursor = notification_query.inbox_page(seeded_db, recipient_user_id=2, category="sale", cursor=None, limit=2)
    assert [item.id for item in first] == [rows[0].id, rows[2].id]
    next_page, _ = notification_query.inbox_page(seeded_db, recipient_user_id=2, category="sale", cursor=cursor, limit=2)
    assert [item.id for item in next_page] == [rows[1].id]


def test_pending_profit_target_uses_exact_order_and_owner_scope(seeded_client, seeded_db):
    account = seeded_db.get(User, 2)
    account.role = "OPERATOR"
    account.owner_scope = "SELF"
    visible = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=2, account_snapshot={"game_account": "visible-aging"})
    hidden = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1)
    pending = _make_unread(seeded_db, recipient_user_id=2, notification_type="PROFIT_PENDING", entity_type="order", entity_id=visible.order_no)
    _make_unread(seeded_db, recipient_user_id=2, notification_type="PROFIT_PENDING", entity_type="other")
    user = CurrentUser.build(id=2, username="seeduser2", roles=["OPERATOR"], owner_scope="SELF")
    auth = {"Authorization": f"Bearer {build_access_token(user)}"}
    response = seeded_client.get("/api/notifications/pending-order", headers=auth)
    assert response.status_code == 200, response.text
    assert response.json() == {"order_no": visible.order_no, "order_id": visible.id}
    response = seeded_client.get("/api/notifications/pending-order", params={"notification_id": pending.id}, headers=auth)
    assert response.json() == {"order_no": visible.order_no, "order_id": visible.id}
    response = seeded_client.get("/api/notifications/pending-order", params={"notification_id": pending.id}, headers={"X-Dev-User": "admin"})
    assert response.json() == {"order_no": None, "order_id": None}
    pending.entity_id = hidden.order_no
    seeded_db.flush()
    response = seeded_client.get("/api/notifications/pending-order", headers=auth)
    assert response.status_code == 200, response.text
    assert response.json() == {"order_no": None, "order_id": None}
    notification_service.mark_read_batch(seeded_db, [pending.id], recipient_user_id=2, actor="pytest")
    assert seeded_client.get("/api/notifications/pending-order", params={"notification_id": pending.id}, headers=auth).json() == {"order_no": None, "order_id": None}
    response = seeded_client.get("/api/notifications/pending-order", headers=auth)
    assert response.json() == {"order_no": None, "order_id": None}
    _buy(seeded_db, visible)
    account = seeded_db.get(Account, visible.account_id)
    account.inventory_entry_at = datetime(2020, 1, 1)
    seeded_db.flush()
    sync = seeded_client.post("/api/notifications/sync-reminders", headers=auth)
    assert sync.status_code == 200, sync.text
    rows = seeded_client.get("/api/notifications/inbox", params={"category": "inventory"}, headers=auth).json()["items"]
    item = next(row for row in rows if row["entity_id"] == str(account.id))
    assert visible.order_no in item["message"]
    assert "成本 500.00" in item["message"]
    assert seeded_client.post("/api/notifications/read", json={"ids": [item["id"]], "category": "inventory"}, headers=auth).status_code == 200
    assert seeded_client.post("/api/notifications/sync-reminders", headers=auth).status_code == 200
    read_rows = seeded_client.get("/api/notifications/inbox", params={"category": "inventory"}, headers=auth).json()["items"]
    assert len([row for row in read_rows if row["entity_id"] == str(account.id) and row["read_at"] is not None]) == 1
    visible.owner_id = 1
    seeded_db.flush()
    for path, params in [("/api/notifications/inbox", {"category": "inventory"})]:
        response = seeded_client.get(path, params=params, headers=auth)
        assert response.status_code == 200
        assert not any(row["id"] == item["id"] for row in response.json()["items"])


def test_inventory_reminder_respects_calendar_threshold_and_changes(seeded_db, monkeypatch):
    from app.domain.options import OptionSet
    from app.workbench.notifications import inventory
    from app.workbench.reminder_config import REMINDER_CODE

    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 11, 22)

    monkeypatch.setattr(inventory, "date", FixedDate)
    setting = seeded_db.scalar(select(OptionSet).where(OptionSet.code == REMINDER_CODE))
    if setting is None:
        setting = OptionSet(code=REMINDER_CODE, label="业务提醒", group="BUSINESS", editable=False, options=[])
        seeded_db.add(setting)
    setting.options = [{"value": "inventory_aging_days", "label": "7"}]
    entries = []
    for index, (age, hour) in enumerate(((8, 12), (7, 0), (7, 12), (6, 12))):
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1, account_snapshot={"game_account": f"aging-boundary-{index}"})
        _buy(seeded_db, order)
        account = seeded_db.get(Account, order.account_id)
        account.inventory_entry_at = datetime(2026, 11, 22, hour) - timedelta(days=age)
        entries.append(str(account.id))
    seeded_db.flush()
    user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"], owner_scope="ALL")
    assert inventory.sync_inventory_notifications_for_user(seeded_db, user) == 1
    def notified():
        return {item.entity_id for item in seeded_db.scalars(select(Notification).where(Notification.recipient_user_id == 1, Notification.notification_type == "INVENTORY_AGING")).all()}
    assert notified() == {entries[0]}
    setting.options = [{"value": "inventory_aging_days", "label": "6"}]
    seeded_db.flush()
    assert inventory.sync_inventory_notifications_for_user(seeded_db, user) == 2
    assert notified() == {entries[0], entries[1], entries[2]}
    assert inventory.sync_inventory_notifications_for_user(seeded_db, user) == 0


def test_inventory_sync_batches_numbers_and_is_idempotent(seeded_db):
    from app.workbench.notifications.inventory import sync_inventory_notifications_for_user
    for i in range(4):
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1, account_snapshot={"game_account": f"aging-batch-{i}"})
        _buy(seeded_db, order)
        seeded_db.get(Account, order.account_id).inventory_entry_at = datetime(2020, 1, 1)
    seeded_db.flush()
    statements = []
    def record_sql(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("UPDATE DOCUMENT_SEQUENCES"):
            statements.append(statement)
    connection = seeded_db.connection()
    event.listen(connection, "before_cursor_execute", record_sql)
    try:
        user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"], owner_scope="ALL")
        assert sync_inventory_notifications_for_user(seeded_db, user) == 4
        assert sync_inventory_notifications_for_user(seeded_db, user) == 0
    finally:
        event.remove(connection, "before_cursor_execute", record_sql)
    rows = seeded_db.scalars(select(Notification).where(Notification.recipient_user_id == 1, Notification.notification_type == "INVENTORY_AGING")).all()
    assert len(rows) == 4
    assert len({row.notification_no for row in rows}) == 4
    assert len(statements) == 1


def test_inventory_sync_and_profit_notice_do_not_deadlock(v1_engine):
    from uuid import uuid4
    from sqlalchemy import create_engine, text
    from app.workbench.notifications.inventory import sync_inventory_notifications_for_user
    from app.domain.base import Base
    from app.settings.field_definitions.seeds import seed_foundation

    # 独立 schema 与真正独立的事务连接，不能复用 seeded_db 的外层事务连接。
    schema = f"notification_concurrency_{uuid4().hex[:12]}"
    with v1_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(v1_engine.url, connect_args={"options": f"-c search_path={schema}"})
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as setup:
            seed_foundation(setup, actor="pytest", include_example_data=True)
            setup.add_all([User(id=1, username="admin", display_name="admin", password_hash="test", role="ADMIN", owner_scope="ALL"),
                           User(id=10, username="pytest", display_name="pytest", password_hash="test", role="ADMIN", owner_scope="ALL")])
            setup.flush()
            order = create_order(setup, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1, account_snapshot={"game_account": "aging-concurrent"})
            _buy(setup, order)
            setup.get(Account, order.account_id).inventory_entry_at = datetime(2020, 1, 1)
            setup.commit()
        user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"], owner_scope="ALL")
        inventory_locked = Event()
        sale_has_sequence = Event()
        sale_inserting = Event()

        def inventory_sync():
            with Session(engine) as session:
                connection = session.connection()
                def before(_conn, _cursor, statement, _params, _context, _many):
                    if statement.lstrip().upper().startswith("UPDATE DOCUMENT_SEQUENCES"):
                        inventory_locked.set()
                        assert sale_has_sequence.wait(5)
                        assert sale_inserting.wait(5)
                event.listen(connection, "before_cursor_execute", before)
                result = sync_inventory_notifications_for_user(session, user)
                session.commit()
                return result

        def profit_notice():
            assert inventory_locked.wait(5)
            with Session(engine) as session:
                def after(_conn, _cursor, statement, _params, _context, _many):
                    if statement.lstrip().upper().startswith("UPDATE DOCUMENT_SEQUENCES"):
                        sale_has_sequence.set()
                def before(_conn, _cursor, statement, _params, _context, _many):
                    if statement.lstrip().upper().startswith("INSERT INTO NOTIFICATIONS"):
                        sale_inserting.set()
                connection = session.connection()
                event.listen(connection, "after_cursor_execute", after)
                event.listen(connection, "before_cursor_execute", before)
                notification_service.create_notification(session, recipient_user_id=1, notification_type="PROFIT_PENDING", title="分润", message="待配置", entity_type="order", entity_id="concurrent")
                session.commit()
                return True

        with ThreadPoolExecutor(max_workers=2) as pool:
            inventory = pool.submit(inventory_sync)
            profit = pool.submit(profit_notice)
            assert profit.result(timeout=10)
            assert inventory.result(timeout=10) == 1
        with Session(engine) as session:
            assert sync_inventory_notifications_for_user(session, user) == 0
            order = create_order(session, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1, account_snapshot={"game_account": "aging-second"})
            _buy(session, order)
            session.get(Account, order.account_id).inventory_entry_at = datetime(2020, 1, 1)
            session.commit()
        def concurrent_sync():
            with Session(engine) as session:
                result = sync_inventory_notifications_for_user(session, user)
                session.commit()
                return result
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(concurrent_sync) for _ in range(2)]
            assert sorted(future.result(timeout=10) for future in futures) == [0, 1]
    finally:
        engine.dispose()
        with v1_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))


def test_mark_read_not_found(seeded_db):
    assert notification_service.mark_read_batch(seeded_db, [999999], recipient_user_id=2, actor="pytest") == []


def test_mark_read_sets_read_at_and_idempotent(seeded_db):
    n = _make_unread(seeded_db)
    assert n.read_at is None
    assert notification_service.mark_read_batch(seeded_db, [n.id], recipient_user_id=2, actor="pytest") == [n.id]
    seeded_db.refresh(n)
    read_at = n.read_at
    assert read_at is not None
    assert notification_service.mark_read_batch(seeded_db, [n.id], recipient_user_id=2, actor="pytest") == [n.id]
    seeded_db.refresh(n)
    assert n.read_at == read_at


def test_batch_read_marks_only_owned_notifications_and_is_idempotent(seeded_client, seeded_db):
    first = _make_unread(seeded_db, recipient_user_id=1, entity_id="first")
    second = _make_unread(seeded_db, recipient_user_id=1, entity_id="second")
    other = _make_unread(seeded_db, recipient_user_id=2, entity_id="other")
    payload = {"ids": [first.id, second.id, other.id, 999999], "category": "latest"}
    response = seeded_client.post("/api/notifications/read", json=payload, headers={"X-Dev-User": "admin"})
    assert response.status_code == 200, response.text
    assert set(response.json()["read_ids"]) == {first.id, second.id}
    seeded_db.refresh(first)
    seeded_db.refresh(second)
    seeded_db.refresh(other)
    assert first.read_at is not None and second.read_at is not None
    assert other.read_at is None
    initial_read_at = first.read_at
    repeat = seeded_client.post("/api/notifications/read", json=payload, headers={"X-Dev-User": "admin"})
    assert set(repeat.json()["read_ids"]) == {first.id, second.id}
    seeded_db.refresh(first)
    assert first.read_at == initial_read_at
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1)
    older = _make_unread(seeded_db, recipient_user_id=1, notification_type="PROFIT_PENDING", entity_type="order", entity_id=order.order_no)
    newer = _make_unread(seeded_db, recipient_user_id=1, notification_type="PROFIT_PENDING", entity_type="order", entity_id=order.order_no)
    notification_service.mark_read_batch(seeded_db, [older.id], recipient_user_id=1, actor="pytest")
    positioned = seeded_client.post("/api/notifications/read", json={"ids": [newer.id], "category": "sale"}, headers={"X-Dev-User": "admin"})
    assert positioned.json()["next_read_id"] == older.id
    assert positioned.json()["read_at"]


def test_concurrent_read_returns_position_after_previous_commit(v1_engine):
    from time import monotonic, sleep
    from uuid import uuid4
    from sqlalchemy import create_engine, text
    from app.domain.base import Base
    from app.settings.field_definitions.seeds import seed_foundation
    from app.workbench.notifications.router import mark_notifications_read
    from app.workbench.notifications.schemas import NotificationReadRequest

    schema = f"notification_read_{uuid4().hex[:12]}"
    with v1_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(v1_engine.url, connect_args={"options": f"-c search_path={schema}"})
    try:
        Base.metadata.create_all(engine)
        with Session(engine, autoflush=False) as setup:
            seed_foundation(setup, actor="pytest", include_example_data=True)
            setup.add(User(id=1, username="admin", display_name="admin", password_hash="test", role="ADMIN", owner_scope="ALL"))
            setup.flush()
            order = create_order(setup, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=1)
            older = _make_unread(setup, recipient_user_id=1, notification_type="PROFIT_PENDING", entity_type="order", entity_id=order.order_no)
            newer = _make_unread(setup, recipient_user_id=1, notification_type="PROFIT_PENDING", entity_type="order", entity_id=order.order_no)
            older_id, newer_id = older.id, newer.id
            setup.commit()

        user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"], owner_scope="ALL")
        reached = Event()
        worker_pid = []

        def read_newer():
            with Session(engine) as session:
                connection = session.connection()
                worker_pid.append(connection.exec_driver_sql("select pg_backend_pid()").scalar_one())
                def before(_conn, _cursor, statement, _params, _context, _many):
                    if "for update" in statement.lower() and "users" in statement.lower():
                        reached.set()
                event.listen(connection, "before_cursor_execute", before)
                result = mark_notifications_read(NotificationReadRequest(ids=[newer_id], category="sale"), db=session, user=user)
                session.commit()
                return result

        with Session(engine) as first, ThreadPoolExecutor(max_workers=1) as executor:
            try:
                assert first.scalar(select(User.id).where(User.id == user.id).with_for_update()) == user.id
                pending = executor.submit(read_newer)
                assert reached.wait(10), "并发读取没有尝试获取接收人锁"
                deadline = monotonic() + 10
                with engine.connect() as observer:
                    while monotonic() < deadline:
                        blocked = observer.scalar(text("select cardinality(pg_blocking_pids(:pid))"), {"pid": worker_pid[0]})
                        if blocked:
                            break
                        assert not pending.done(), "并发读取未等待接收人锁"
                        sleep(0.01)
                    else:
                        pytest.fail("没有观察到并发读取等待接收人锁")
                mark_notifications_read(NotificationReadRequest(ids=[older_id], category="sale"), db=first, user=user)
                first.commit()
                result = pending.result(timeout=10)
                assert result.read_ids == [newer_id] and result.next_read_id == older_id
            finally:
                first.rollback()
    finally:
        engine.dispose()
        with v1_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))


TODAY = date(2026, 10, 4)

def _buy(seeded_db, order: Order) -> None:
    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("500"),
        occurred_on=TODAY,
        actor="pytest",
    )
