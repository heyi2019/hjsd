"""NOTIFY-01 #28 通知接入回归：分润提醒两段式（用户 11-12 裁决）。

① 售出完成 → 通知本次 SELL 执行人「去录分润」（PROFIT_PENDING，待办）；
② 分润保存完成 → 通知利润接收人「分润已确认」（PROFIT_ALLOCATED，结果）。

覆盖两种先后顺序、幂等去重、公司归属排除、SELL 执行人回退。
两段文案均含「分润」，命中前端工作台 /分润|利润|提成/ 过滤。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.core.security import CurrentUser, build_access_token
from app.domain.notifications import Notification
from app.domain.trade import Account, Order, OrderEvent
from app.domain.users import User
from app.notifications import triggers
from app.orders.create import create_order
from app.orders.events import post_event
from app.policy import allocations as policy_allocations

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)


def _uid(seeded_db, username: str) -> int:
    user_id = seeded_db.scalar(select(User.id).where(User.username == username))
    assert user_id is not None, f"种子用户 {username} 不存在"
    return int(user_id)


def _account(seeded_db, suffix: str) -> Account:
    acc = Account(
        game_account=f"b6n-{suffix}",
        platform="王者",
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


# ---------------------------------------------------------------- 段① 售出提醒
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
    triggers.notify_on_sell_completed(seeded_db, order, sell_event, actor="pytest")
    assert len(_notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)) == 1


def test_sell_without_operator_ids_falls_back_to_actor(seeded_db):
    """事件未标操作人时，回退到 actor 对应的用户（seeduser3）。"""
    seller_id = _uid(seeded_db, "seeduser3")
    order = _order(seeded_db, "s3")
    _buy(seeded_db, order)
    _sell(seeded_db, order, operator_ids=None, actor="seeduser3")
    assert len(_notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)) == 1


# ---------------------------------------------------------------- 段② 分润结果
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


# ---------------------------------------------------------------- 顺序与延迟
def test_set_allocations_before_completion_defers_notification(seeded_db):
    """订单未完成时先分润不发结果通知；待 SELL 闭环由段①入口补发。"""
    seller_id = _uid(seeded_db, "seeduser1")
    recipient_id = _uid(seeded_db, "seeduser2")
    order = _order(seeded_db, "o1")
    _buy(seeded_db, order)
    _set_person_allocations(
        seeded_db,
        order,
        [{"user_id": recipient_id, "role": "OWNER", "allocation_rate": "100"}],
    )
    assert not _notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)

    _sell(seeded_db, order, operator_ids=[seller_id])
    assert len(_notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)) == 1
    # 已有分润行 → 不再提醒售出人「去分润」
    assert not _notifs(seeded_db, seller_id, triggers.PROFIT_PENDING)


def test_order_not_completed_never_notifies(seeded_db):
    """仅 BUY 未 SELL：任何通知都不应产生（未闭环）。"""
    recipient_id = _uid(seeded_db, "seeduser2")
    order = _order(seeded_db, "o2")
    _buy(seeded_db, order)
    _set_person_allocations(
        seeded_db,
        order,
        [{"user_id": recipient_id, "role": "OWNER", "allocation_rate": "100"}],
    )
    assert not _notifs(seeded_db, recipient_id, triggers.PROFIT_ALLOCATED)
    assert not list(seeded_db.scalars(select(Notification)).all())


# ---------------------------------------------------------------- API 端到端
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
