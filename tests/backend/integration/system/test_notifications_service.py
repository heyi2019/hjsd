"""API-01 / NOTIFY-01 通知功能：通知读写规则与售出、分润提醒闭环。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.notifications import Notification
from app.domain.trade import Account, Order, OrderEvent
from app.domain.users import User
from app.dashboard.notifications import triggers
from app.dashboard.notifications import service as notification_service
from app.business.create import create_order
from app.business.events import post_event
from app.funds.profit_allocation import service as policy_allocations


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
    unread, unread_total = notification_service.list_notifications(
        seeded_db, recipient_user_id=2, unread_only=True
    )
    assert unread_total == 1
    assert [n.id for n in unread] == [b.id]
    all_rows, all_total = notification_service.list_notifications(
        seeded_db, recipient_user_id=2, unread_only=False
    )
    assert all_total == 2
    assert len(all_rows) == 2
    first = _make_unread(seeded_db, recipient_user_id=1, notification_type="PROFIT_PENDING", entity_id="FIRST")
    second = _make_unread(seeded_db, recipient_user_id=1, notification_type="PROFIT_ALLOCATED", entity_id="SECOND")
    third = _make_unread(seeded_db, recipient_user_id=1, notification_type="PROFIT_PENDING", entity_id="THIRD")
    notification_service.mark_read_batch(seeded_db, [second.id], recipient_user_id=1, actor="pytest")
    headers = {"X-Dev-User": "admin"}
    page = seeded_client.get("/api/notifications/inbox", params={"category": "sale", "limit": 2}, headers=headers)
    assert page.status_code == 200
    result = page.json()
    assert [item["id"] for item in result["items"]] == [third.id, first.id]
    assert result["next_cursor"]
    notification_service.mark_read_batch(seeded_db, [third.id], recipient_user_id=1, actor="pytest")
    page = seeded_client.get("/api/notifications/inbox", params={"category": "sale", "limit": 2, "cursor": result["next_cursor"]}, headers=headers)
    assert [item["id"] for item in page.json()["items"]] == [second.id]
    assert page.json()["next_cursor"] is None
    latest = seeded_client.get("/api/notifications/inbox", params={"category": "latest"}, headers=headers)
    assert [item["id"] for item in latest.json()["items"]] == [first.id]


def test_notification_cursor_keeps_later_unread_after_previous_page_is_read(seeded_db):
    rows = [_make_unread(seeded_db, notification_type="PROFIT_ALLOCATED", entity_type="order", entity_id=str(i)) for i in range(3)]
    _make_unread(seeded_db, notification_type="PROFIT_ALLOCATED", entity_type="other")
    assert notification_service.unread_profit_counts(seeded_db, recipient_user_id=2)["allocated_profit_count"] == 3
    first, total = notification_service.list_notifications(
        seeded_db, recipient_user_id=2, unread_only=True, notification_type="PROFIT_ALLOCATED", entity_type="order", limit=2,
    )
    assert total == 3
    assert [item.id for item in first] == [rows[2].id, rows[1].id]
    notification_service.mark_read_batch(seeded_db, [item.id for item in first], recipient_user_id=2, actor="pytest")
    second, _ = notification_service.list_notifications(
        seeded_db, recipient_user_id=2, unread_only=True, notification_type="PROFIT_ALLOCATED", entity_type="order", before_id=first[-1].id, limit=2,
    )
    assert [item.id for item in second] == [rows[0].id]
    rows[0].created_at = datetime(2026, 11, 22, 10)
    rows[1].created_at = datetime(2026, 11, 21, 10)
    rows[2].created_at = datetime(2026, 11, 21, 10)
    seeded_db.flush()
    first, _ = notification_service.list_notifications(seeded_db, recipient_user_id=2, notification_type="PROFIT_ALLOCATED", entity_type="order", sort_by_time=True, limit=2)
    assert [item.id for item in first] == [rows[0].id, rows[2].id]
    next_page, _ = notification_service.list_notifications(seeded_db, recipient_user_id=2, notification_type="PROFIT_ALLOCATED", entity_type="order", sort_by_time=True, before_created_at=first[-1].created_at, before_id=first[-1].id, limit=2)
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
    assert response.json() == {"order_no": hidden.order_no, "order_id": None}
    notification_service.mark_read_batch(seeded_db, [pending.id], recipient_user_id=2, actor="pytest")
    assert seeded_client.get("/api/notifications/pending-order", params={"notification_id": pending.id}, headers=auth).json() == {"order_no": hidden.order_no, "order_id": None}
    response = seeded_client.get("/api/notifications/pending-order", headers=auth)
    assert response.json() == {"order_no": None, "order_id": None}
    _buy(seeded_db, visible)
    account = seeded_db.get(Account, visible.account_id)
    account.inventory_entry_at = datetime(2020, 1, 1)
    seeded_db.flush()
    sync = seeded_client.post("/api/notifications/sync-inventory", headers=auth)
    assert sync.status_code == 200, sync.text
    rows = seeded_client.get("/api/notifications", params={"category": "inventory", "unread_only": True}, headers=auth).json()["items"]
    item = next(row for row in rows if row["entity_id"] == str(account.id))
    assert visible.order_no in item["message"]
    assert "成本 500.00" in item["message"]
    assert seeded_client.post("/api/notifications/read", json={"ids": [item["id"]]}, headers=auth).status_code == 200
    assert seeded_client.post("/api/notifications/sync-inventory", headers=auth).status_code == 200
    read_rows = seeded_client.get("/api/notifications", params={"category": "inventory", "read_only": True}, headers=auth).json()["items"]
    assert len([row for row in read_rows if row["entity_id"] == str(account.id)]) == 1


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
    payload = {"ids": [first.id, second.id, other.id, 999999]}
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


# 售出与分润通知业务闭环

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)

def _uid(seeded_db, username: str) -> int:
    user_id = seeded_db.scalar(select(User.id).where(User.username == username))
    assert user_id is not None, f"种子用户 {username} 不存在"
    return int(user_id)

def _account(seeded_db, suffix: str) -> Account:
    acc = Account(
        game_account=f"b6n-{suffix}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        status="WAITING",
        stock_no=f"KU_B6N_{suffix}",
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(acc)
    seeded_db.commit()
    return acc

def _order(seeded_db, suffix: str) -> Order:
    return create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=_account(seeded_db, suffix).id,
    )

def _buy(seeded_db, order: Order) -> None:
    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("500"),
        occurred_on=TODAY,
        actor="pytest",
    )

def _sell(seeded_db, order: Order, *, operator_ids=None, actor: str = "seeduser1") -> None:
    post_event(
        seeded_db,
        order.id,
        event_type="SELL",
        amount=Decimal("800"),
        occurred_on=TODAY2,
        actor=actor,
        operator_user_ids=operator_ids,
    )

def _set_person_allocations(seeded_db, order: Order, items: list[dict]) -> None:
    policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

def _notifs(seeded_db, recipient_id: int, ntype: str) -> list[Notification]:
    return list(
        seeded_db.scalars(
            select(Notification).where(
                Notification.recipient_user_id == recipient_id,
                Notification.notification_type == ntype,
            )
        ).all()
    )

def test_sell_completed_notifies_seller_to_allocate(seeded_db):
    """先卖后分润：SELL 闭环提醒本次执行人去录分润，文案含「分润」命中前端过滤。"""
    seller_id = _uid(seeded_db, "seeduser1")
    order = _order(seeded_db, "s1")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=[seller_id])

    rows = _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)
    assert len(rows) == 1
    assert "分润" in rows[0].title
    assert "分润" in rows[0].message
    assert rows[0].entity_type == "order"
    assert rows[0].entity_id == order.order_no
    assert not _notifs(seeded_db, seller_id, triggers.PROFIT_ALLOCATED)
    sell_event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
    post_event(seeded_db, order.id, event_type="CANCEL", amount="800", occurred_on=TODAY2,
               actor="pytest", offset_event_id=sell_event.id, reason="取消售出")
    assert rows[0].read_at is None
    other_id = _uid(seeded_db, "seeduser2")
    _sell(seeded_db, order, operator_ids=[other_id])
    assert len([row for row in _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING) if row.read_at is None]) == 1
    assert len([row for row in _notifs(seeded_db, other_id, triggers.PROFIT_PENDING) if row.read_at is None]) == 1

def test_sell_pending_notification_is_idempotent(seeded_db):
    """同一售出人同一订单重复触发也只提醒一次。"""
    seller_id = _uid(seeded_db, "seeduser1")
    order = _order(seeded_db, "s2")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=[seller_id])

    sell_event = seeded_db.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == "SELL",
        )
    )
    triggers.notify_seller_to_allocate(seeded_db, order, sell_event, actor="pytest")
    assert len(_notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)) == 1
    notification = _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)[0]
    notification_service.mark_read_batch(seeded_db, [notification.id], recipient_user_id=seller_id, actor="pytest")
    triggers.notify_seller_to_allocate(seeded_db, order, sell_event, actor="pytest")
    assert notification.read_at is not None

    post_event(seeded_db, order.id, event_type="CANCEL", amount="800", occurred_on=TODAY2,
               actor="pytest", offset_event_id=sell_event.id, reason="取消售出")
    _sell(seeded_db, order, operator_ids=[seller_id])
    rows = _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)
    assert len(rows) == 2
    assert notification.read_at is not None
    assert sum(row.read_at is None for row in rows) == 1

def test_sell_without_operator_ids_falls_back_to_actor(seeded_db):
    """事件未标操作人时，回退到 actor 对应的用户（seeduser3）。"""
    seller_id = _uid(seeded_db, "seeduser3")
    order = _order(seeded_db, "s3")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=None, actor="seeduser3")
    assert len(_notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)) == 1

def test_set_allocations_after_completion_notifies_recipients(seeded_db):
    """先卖后分润：SELL 提醒售出人，保存分润后通知利润接收人。"""
    seller_id = _uid(seeded_db, "seeduser1")
    recipient_id = _uid(seeded_db, "seeduser2")
    order = _order(seeded_db, "p1")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=[seller_id, recipient_id])

    with pytest.raises(Validation):
        _set_person_allocations(seeded_db, order, [])
    assert _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)[0].read_at is None

    _set_person_allocations(
        seeded_db,
        order,
        [{"user_id": recipient_id, "role": "OWNER", "allocation_rate": "100"}],
    )

    assert len(_notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)) == 1
    assert len(_notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)) == 1
    assert _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)[0].read_at is None
    assert _notifs(seeded_db, recipient_id, triggers.PROFIT_PENDING)[0].read_at is None

def test_set_allocations_repeat_is_idempotent(seeded_db):
    """重复保存同一分润，接收人只收到一次「已确认」。"""
    recipient_id = _uid(seeded_db, "seeduser2")
    order = _order(seeded_db, "p2")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=[_uid(seeded_db, "seeduser1")])
    items = [{"user_id": recipient_id, "role": "OWNER", "allocation_rate": "100"}]
    _set_person_allocations(seeded_db, order, items)
    _set_person_allocations(seeded_db, order, items)
    assert len(_notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)) == 1
    notification = _notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)[0]
    notification_service.mark_read_batch(seeded_db, [notification.id], recipient_user_id=recipient_id, actor="pytest")
    changed = [{"user_id": recipient_id, "role": "OWNER", "allocation_rate": "60"},
               {"user_id": None, "role": "OWNER", "allocation_rate": "40"}]
    _set_person_allocations(seeded_db, order, changed)
    rows = _notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)
    assert len(rows) == 2
    assert sum(row.read_at is None for row in rows) == 1
    _set_person_allocations(seeded_db, order, changed)
    assert len(_notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)) == 2

    sell_event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
    post_event(seeded_db, order.id, event_type="CANCEL", amount="800", occurred_on=TODAY2,
               actor="pytest", offset_event_id=sell_event.id, reason="取消售出")
    _sell(seeded_db, order, operator_ids=[_uid(seeded_db, "seeduser1")])
    _set_person_allocations(seeded_db, order, changed)
    rows = _notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)
    assert len(rows) == 3
    assert sum(row.read_at is None for row in rows) == 2

    replacement_id = _uid(seeded_db, "seeduser3")
    _set_person_allocations(seeded_db, order, [{"user_id": replacement_id, "role": "OWNER", "allocation_rate": "100"}])
    assert sum(row.read_at is None for row in _notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)) == 2
    assert len([row for row in _notifs(seeded_db, replacement_id, triggers.PROFIT_ALLOCATED) if row.read_at is None]) == 1
    _set_person_allocations(seeded_db, order, [{"user_id": replacement_id, "role": "OWNER", "allocation_rate": "0"},
                                               {"user_id": None, "role": "OWNER", "allocation_rate": "100"}])
    assert sum(row.read_at is None for row in _notifs(seeded_db, replacement_id, triggers.PROFIT_ALLOCATED)) == 1

def test_company_allocation_is_not_notified(seeded_db):
    """公司归属（user_id 为空）不通知，只通知绑定的利润接收人。"""
    recipient_id = _uid(seeded_db, "seeduser2")
    zero_share_id = _uid(seeded_db, "seeduser3")
    order = _order(seeded_db, "p3")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=[_uid(seeded_db, "seeduser1")])
    _set_person_allocations(
        seeded_db,
        order,
        [
            {"user_id": recipient_id, "role": "OWNER", "allocation_rate": "70"},
            {"user_id": zero_share_id, "role": "OWNER", "allocation_rate": "0"},
            {"user_id": None, "role": "OWNER", "allocation_rate": "30"},
        ],
    )
    allocated = list(
        seeded_db.scalars(
            select(Notification).where(
                Notification.notification_type == triggers.PROFIT_ALLOCATED
            )
        ).all()
    )
    assert len(allocated) == 1
    assert allocated[0].recipient_user_id == recipient_id
    assert not _notifs(seeded_db, zero_share_id, triggers.PROFIT_ALLOCATED)
    loss_order = _order(seeded_db, "p3loss")
    post_event(seeded_db, loss_order.id, event_type="BUY", amount="1000", occurred_on=TODAY, actor="pytest")
    _sell(seeded_db, loss_order, operator_ids=[_uid(seeded_db, "seeduser1")])
    _set_person_allocations(seeded_db, loss_order, [{"user_id": zero_share_id, "role": "OWNER", "allocation_amount": "-100"}])
    assert len(_notifs(seeded_db, zero_share_id, triggers.PROFIT_ALLOCATED)) == 1

def test_sell_api_creates_notification_visible_in_seller_inbox(seeded_client, seeded_db):
    """端到端：SELL 端点登记后，售出人工作台未读通知能查到「分润」提醒。"""
    seller_id = _uid(seeded_db, "seeduser1")
    order = _order(seeded_db, "api1")
    _buy(seeded_db, order)

    resp = seeded_client.post(
        f"/api/orders/{order.id}/events",
        json={
            "event_type": "SELL",
            "amount": "800",
            "occurred_on": TODAY2.isoformat(),
            "operator_user_ids": [seller_id],
        },
        headers={"X-Dev-User": "admin"},
    )
    assert resp.status_code in (200, 201), resp.text

    seller = CurrentUser.build(
        id=seller_id, username="seeduser1", roles=["OPERATOR"], owner_scope="SELF"
    )
    inbox = seeded_client.get(
        "/api/notifications",
        params={"unread_only": "true"},
        headers={"Authorization": f"Bearer {build_access_token(seller)}"},
    )
    assert inbox.status_code == 200, inbox.text
    body = inbox.json()
    assert body["total"] >= 1
    assert any(
        "分润" in (item.get("title", "") + item.get("message", ""))
        for item in body["items"]
    )
    _make_unread(seeded_db, recipient_user_id=seller_id, notification_type="OTHER", entity_id="newer")
    filtered = seeded_client.get(
        "/api/notifications",
        params={"unread_only": "true", "notification_type": "PROFIT_PENDING", "limit": 1},
        headers={"Authorization": f"Bearer {build_access_token(seller)}"},
    )
    assert filtered.status_code == 200, filtered.text
    assert filtered.json()["total"] == 1
    assert filtered.json()["unread_total"] == 2
    assert filtered.json()["items"][0]["notification_type"] == "PROFIT_PENDING"


def test_profit_notification_details_only_returns_visible_owned_notifications(seeded_client, seeded_db):
    admin_id = 1  # X-Dev-User admin
    order = _order(seeded_db, "details")
    _buy(seeded_db, order)
    _sell(seeded_db, order)
    mine = _make_unread(seeded_db, recipient_user_id=admin_id, notification_type="PROFIT_ALLOCATED", entity_type="order", entity_id=order.order_no)
    pending = _make_unread(seeded_db, recipient_user_id=admin_id, notification_type="PROFIT_PENDING", entity_type="order", entity_id=order.order_no)
    other = _make_unread(seeded_db, recipient_user_id=_uid(seeded_db, "seeduser2"), notification_type="PROFIT_ALLOCATED", entity_type="order", entity_id=order.order_no)
    missing = _make_unread(seeded_db, recipient_user_id=admin_id, notification_type="PROFIT_ALLOCATED", entity_type="order", entity_id="NO-SUCH-ORDER")

    response = seeded_client.get("/api/notifications/profit-details", params=[("ids", mine.id), ("ids", other.id), ("ids", missing.id)], headers={"X-Dev-User": "admin"})
    assert response.status_code == 200, response.text
    assert [item["notification_id"] for item in response.json()] == [mine.id]
    assert response.json()[0]["order_no"] == order.order_no
    assert Decimal(response.json()[0]["sale_amount"]) == Decimal("800")
    pending_detail = seeded_client.get("/api/notifications/profit-details", params={"ids": pending.id}, headers={"X-Dev-User": "admin"})
    assert pending_detail.status_code == 200, pending_detail.text
    detail = pending_detail.json()[0]
    ledger = seeded_client.get("/api/orders", params={"keyword": order.order_no}, headers={"X-Dev-User": "admin"}).json()
    ledger_order = next(item for item in ledger["items"] if item["id"] == order.id)
    assert Decimal(detail["cost_amount"]) == Decimal(ledger_order["cost_amount"])
    allocation = seeded_client.get(f"/api/orders/{order.id}/profit-allocations", headers={"X-Dev-User": "admin"}).json()
    assert Decimal(detail["allocatable_profit"]) == Decimal(allocation["allocatable_profit"])
    original = seeded_client.get(f"/api/orders/{order.id}/execution-detail", headers={"X-Dev-User": "admin"})
    assert original.status_code == 200, original.text
    execution = original.json()
    detail = response.json()[0]
    assert detail["stock_no"] == execution["account"]["stock_no"]
    assert detail["inventory_entry_at"] == execution["account"]["inventory_entry_at"]
    assert detail["removed_at"] == execution["detail_view"]["lifecycle"]["removed_at"]
    recovery = next(row for row in execution["detail_view"]["execution_rows"] if row["category"] == "INBOUND")
    assert detail["recovery_operator"] == recovery["operator"]
    scoped_account = seeded_db.get(User, 2)
    scoped_account.role = "OPERATOR"
    scoped_account.owner_scope = "SELF"
    seeded_db.flush()
    scoped = CurrentUser.build(id=2, username="seeduser2", roles=["OPERATOR"], owner_scope="SELF")
    denied = seeded_client.get("/api/notifications/profit-details", params={"ids": other.id}, headers={"Authorization": f"Bearer {build_access_token(scoped)}"})
    assert denied.status_code == 200, denied.text
    assert denied.json() == []


def test_profit_notification_details_batch_does_not_query_per_order(seeded_client, seeded_db):
    from sqlalchemy import event

    ids = []
    for index in range(3):
        order = _order(seeded_db, f"batch-{index}")
        _buy(seeded_db, order)
        _sell(seeded_db, order)
        ids.append(_make_unread(seeded_db, recipient_user_id=1, notification_type="PROFIT_ALLOCATED", entity_type="order", entity_id=order.order_no).id)
    statements = []
    connection = seeded_db.connection()

    def record(_connection, _cursor, statement, _params, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(connection, "before_cursor_execute", record)
    try:
        one = seeded_client.get("/api/notifications/profit-details", params=[("ids", ids[0])], headers={"X-Dev-User": "admin"})
        one_count = len(statements)
        statements.clear()
        many = seeded_client.get("/api/notifications/profit-details", params=[("ids", value) for value in ids], headers={"X-Dev-User": "admin"})
        many_count = len(statements)
    finally:
        event.remove(connection, "before_cursor_execute", record)
    assert one.status_code == many.status_code == 200
    assert len(many.json()) == 3
    assert many_count <= one_count + 1, (one_count, many_count)
