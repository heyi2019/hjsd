"""API-01 / NOTIFY-01 通知功能：通知读写规则与售出、分润提醒闭环。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
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


def test_list_notifications_unread_only_filters(seeded_db):
    a = _make_unread(seeded_db, entity_id="A")
    b = _make_unread(seeded_db, entity_id="B")
    notification_service.mark_read(seeded_db, a.id, recipient_user_id=2, actor="pytest")
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


def test_mark_read_not_found(seeded_db):
    with pytest.raises(NotFound, match="通知不存在"):
        notification_service.mark_read(
            seeded_db, 999999, recipient_user_id=2, actor="pytest"
        )


def test_mark_read_sets_read_at_and_idempotent(seeded_db):
    n = _make_unread(seeded_db)
    assert n.read_at is None
    updated = notification_service.mark_read(
        seeded_db, n.id, recipient_user_id=2, actor="pytest"
    )
    assert updated.read_at is not None
    # 幂等：再次 mark_read 不重设 read_at（L134 的 is None 守卫）
    again = notification_service.mark_read(
        seeded_db, n.id, recipient_user_id=2, actor="pytest"
    )
    assert again.read_at == updated.read_at


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
    assert rows[0].read_at is not None
    other_id = _uid(seeded_db, "seeduser2")
    _sell(seeded_db, order, operator_ids=[other_id])
    assert len([row for row in _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING) if row.read_at is None]) == 0
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
    notification_service.mark_read(seeded_db, notification.id, recipient_user_id=seller_id, actor="pytest")
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
    _sell(seeded_db, order, operator_ids=[seller_id])

    _set_person_allocations(
        seeded_db,
        order,
        [{"user_id": recipient_id, "role": "OWNER", "allocation_rate": "100"}],
    )

    assert len(_notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)) == 1
    assert len(_notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)) == 1

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

def test_company_allocation_is_not_notified(seeded_db):
    """公司归属（user_id 为空）不通知，只通知绑定的利润接收人。"""
    recipient_id = _uid(seeded_db, "seeduser2")
    order = _order(seeded_db, "p3")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=[_uid(seeded_db, "seeduser1")])
    _set_person_allocations(
        seeded_db,
        order,
        [
            {"user_id": recipient_id, "role": "OWNER", "allocation_rate": "70"},
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

def test_sell_api_creates_notification_visible_in_seller_inbox(seeded_client, seeded_db):
    """端到端：SELL 端点登记后，售出人工作台未读通知能查到「分润」提醒。"""
    seller_id = _uid(seeded_db, "seeduser1")
    order = _order(seeded_db, "api1")
    _buy(seeded_db, order)

    resp = seeded_client.post(
        f"/api/v1/orders/{order.id}/events",
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
        "/api/v1/notifications",
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
