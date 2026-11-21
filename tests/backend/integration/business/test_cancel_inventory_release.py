"""INVENTORY-02 无流水取消后的库存回收规则。

判定依据是「有无已登记（过账）资金事件」：无事件时账号状态从未因本单改变过，
取消会使与本单一对一绑定的账号退出库存。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import AccountStatus
from app.domain.trade import Account
from app.domain.notifications import Notification
from app.domain.users import User
from app.business.shared.cancellation_model import cancel_order
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.business.orders.queries import list_orders, order_status_counts
from app.business.inventory import inventory as inventory_service

D = date(2026, 11, 1)


def _snapshot(game_account: str) -> dict[str, str]:
    return {"game_account": game_account, "game_type": "王者荣耀"}


def _inventory_ids(session) -> set[int]:
    return {row["account_id"] for row in inventory_service.inventory(session)}


def test_hs_plain_cancel_voids_inline_account_and_exits_inventory(seeded_db):
    """内联建库的回收单无流水取消后，账号退出库存，不再可被误卖。"""
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-inline-hs"),
    )
    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    assert (account.status, account.inventory_status) == ("WAITING", "IN_STOCK")
    assert account.id in _inventory_ids(seeded_db)

    cancel_order(seeded_db, order.id, actor="pytest", reason="客户撤单")
    seeded_db.refresh(account)

    assert account.status == AccountStatus.VOID.value
    assert account.inventory_status == "OUT_OF_STOCK"
    assert account.id not in _inventory_ids(seeded_db)
    # 历史行保留：前端建单判重靠 status=VOID 排除它，而不是靠物理删除。
    assert account.id in {row.id for row in inventory_service.list_accounts(seeded_db)}


def test_cancelled_inline_account_allows_same_game_account_rebuy(seeded_db):
    """取消后同一游戏账号可以重新建单，不被「已有未售出库存账号」挡下。"""
    first = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-then-rebuy"),
    )
    cancel_order(seeded_db, first.id, actor="pytest", reason="客户撤单")

    second = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-then-rebuy"),
    )

    assert second.account_id != first.account_id
    reborn = seeded_db.get(Account, second.account_id)
    assert (reborn.status, reborn.inventory_status) == ("WAITING", "IN_STOCK")
    # 只有新账号在库，被取消那张保持 VOID，不会出现两条在库记录。
    assert _inventory_ids(seeded_db) == {reborn.id}


def test_plain_cancel_with_posted_event_is_blocked_and_account_untouched(seeded_db):
    """有已登记事件时仍拦下要求先冲销，且不擅自改账号状态。"""
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-with-event"),
    )
    account = seeded_db.get(Account, order.account_id)
    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("100"),
        occurred_on=D,
        actor="pytest",
    )
    before = (account.status, account.inventory_status)

    with pytest.raises(Validation, match="登记事件"):
        cancel_order(seeded_db, order.id, actor="pytest", reason="不能直接取消")

    seeded_db.refresh(account)
    assert (account.status, account.inventory_status) == before


def test_dg_platform_offsale_keeps_account_in_stock(seeded_db):
    """代挂「平台下架」只终止本系统订单，账号仍在平台挂出，不退出库存。"""
    order = create_order(
        seeded_db,
        order_type="DG",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("dg-platform-offsale"),
    )
    account = seeded_db.get(Account, order.account_id)

    cancel_order(
        seeded_db,
        order.id,
        actor="pytest",
        reason="平台下架",
        form_extra_scope="INVOID",
        form_extra={"platform_unlist_scope": "PLATFORM"},
    )
    seeded_db.refresh(account)

    assert account.status == AccountStatus.WAITING.value
    assert account.inventory_status == "IN_STOCK"


@pytest.mark.parametrize("order_type", ["HS", "TH"])
def test_cancel_completed_sale_returns_account_to_inventory(seeded_db, order_type):
    from app.funds.profit_allocation.service import set_allocations
    from app.operations.r3_commission import r3_commission_reconciliation

    snapshot = {**_snapshot(f"cancel-sale-{order_type}"), "bound_phone": "13700000001"}
    order = create_order(seeded_db, order_type=order_type, trade_date=D, actor="pytest", account_snapshot=snapshot, form_extra={"intermediary_platform": "买号平台"})
    assert order.form_extra["bound_phone"] == "13700000001"
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=D, actor="pytest")
    sell, _ = post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("200"), occurred_on=D, actor="pytest", bound_phone="13900000002", form_extra_context={"intermediary_platform": "第一次售出平台", "delivery_responsible_ids": [1]})
    assert order.form_extra["sell_intermediary_platform"] == "第一次售出平台"
    first_delivery, _ = post_event(
        seeded_db, order.id, event_type="DELIVER", delivery_direction="SELL",
        occurred_on=D, actor="pytest", note="第一次交付凭证", bound_phone="13900000002",
    )
    with pytest.raises(Validation, match="已经登记过卖号交付"):
        post_event(seeded_db, order.id, event_type="DELIVER", delivery_direction="SELL", occurred_on=D, actor="pytest", note="重复交付")
    post_event(seeded_db, order.id, event_type="CANCEL", amount=Decimal("200"), occurred_on=D, actor="pytest", offset_event_id=sell.id, pool_id=sell.pool_id, reason="取消售出")
    account = seeded_db.get(Account, order.account_id)
    assert account.status == AccountStatus.WAITING.value
    assert account.inventory_status == "IN_STOCK"
    assert account.id in _inventory_ids(seeded_db)
    assert order.status == "ACTIVE"
    resold, _ = post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("220"), occurred_on=date(2026, 11, 2), actor="pytest")
    assert resold.event_type == "SELL"
    assert order.form_extra["intermediary_platform"] == "买号平台"
    assert order.form_extra["bound_phone"] == "13700000001"
    assert order.form_extra["sell_intermediary_platform"] is None
    assert order.form_extra["sell_delivery_responsible_ids"] is None
    second_delivery, flow = post_event(
        seeded_db, order.id, event_type="DELIVER", delivery_direction="SELL",
        occurred_on=D, actor="pytest", note="再次售出的交付凭证", bound_phone="13900000003",
    )
    assert flow is None
    assert first_delivery.id < resold.id < second_delivery.id
    assert first_delivery.form_extra["bound_phone"] == "13900000002"
    assert second_delivery.form_extra["bound_phone"] == "13900000003"
    assert order.form_extra["bound_phone"] == "13700000001"
    assert order.form_extra["sell_bound_phone"] == "13900000003"
    with pytest.raises(Validation, match="已经登记过卖号交付"):
        post_event(seeded_db, order.id, event_type="DELIVER", delivery_direction="SELL", occurred_on=D, actor="pytest", note="再次重复交付")
    set_allocations(seeded_db, order.id, items=[{"user_id": 1, "role": "OWNER", "allocation_rate": "100"}], actor="pytest")
    group = next(group for group in r3_commission_reconciliation(seeded_db)["order_groups"] if group["order_id"] == order.id)
    assert group["outbound_date"] == date(2026, 11, 2)
    assert group["orders"][0]["outbound_date"] == date(2026, 11, 2)


@pytest.mark.parametrize("order_type", ["HS", "TH"])
def test_cancel_sale_with_partial_refund_returns_inventory(seeded_client, seeded_db, headers, order_type):
    from app.funds.profit_allocation.service import set_allocations
    from app.operations.r3_commission import r3_commission_reconciliation
    from app.shared.order_amounts import order_cashflow_profit_by_order
    order = create_order(seeded_db, order_type=order_type, trade_date=D, actor="pytest", account_snapshot=_snapshot(f"partial-sale-{order_type}"))
    operators = list(seeded_db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id).limit(2)))
    operator, previous_operator = operators
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=D, actor="pytest")
    sell, _ = post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("200"), occurred_on=D, actor="pytest", operator_user_ids=[previous_operator.id])
    response = seeded_client.post(f"/api/orders/{order.id}/events", headers=headers, json={"event_type": "CANCEL", "amount": "150", "occurred_on": "2026-11-01", "offset_event_id": sell.id, "pool_id": sell.pool_id, "reason": "取消售出", "finalize_sale_cancel": True})
    assert response.status_code == 201, response.text
    seeded_db.flush()
    pending = seeded_db.scalar(select(Notification).where(Notification.recipient_user_id == previous_operator.id, Notification.notification_type == "PROFIT_PENDING", Notification.entity_id == order.order_no))
    assert pending.read_at is None
    assert seeded_db.get(Account, order.account_id).status == "WAITING"
    assert order.status == "ACTIVE"
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == -50
    resold, _ = post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("220"), occurred_on=date(2026, 10, 31), actor="pytest", operator_user_ids=[operator.id])
    assert resold.event_type == "SELL"
    response = seeded_client.get("/api/orders", headers=headers, params={"keyword": order.order_no})
    assert response.status_code == 200, response.text
    item = next(item for item in response.json()["items"] if item["id"] == order.id)
    assert Decimal(str(item["sale_amount"])) == Decimal("220")
    assert item["sale_at"].startswith("2026-10-31")
    assert item["sale_operator"] == (operator.display_name or operator.username)
    assert Decimal(str(item["profit_base"])) == Decimal("170")
    for selected, expected_total in ((operator, 1), (previous_operator, 0)):
        filtered = seeded_client.get("/api/orders", headers=headers, params={"keyword": order.order_no, "sale_operator_ids": selected.id})
        assert filtered.status_code == 200, filtered.text
        assert filtered.json()["total"] == expected_total
        assert len(filtered.json()["items"]) == expected_total
        personal_user = CurrentUser.build(id=selected.id, username=selected.username, roles=["OPERATOR"], owner_scope="ALL")
        personal = list_orders(seeded_db, keyword=order.order_no, user=personal_user, mine=True)
        assert len(personal) == expected_total
        assert sum(order_status_counts(seeded_db, user=personal_user, mine=True, trade_date_from=D, trade_date_to=D).values()) == expected_total

    old_refund = {"event_type": "CANCEL", "amount": "50", "occurred_on": "2026-11-01", "offset_event_id": sell.id, "pool_id": sell.pool_id, "reason": "补退首次售出余款"}
    response = seeded_client.post(f"/api/orders/{order.id}/events", headers=headers, json={**old_refund, "finalize_sale_cancel": True})
    assert response.status_code == 422, response.text
    response = seeded_client.post(f"/api/orders/{order.id}/events", headers=headers, json=old_refund)
    assert response.status_code == 201, response.text
    seeded_db.refresh(order)
    account = seeded_db.get(Account, order.account_id)
    seeded_db.refresh(account)
    assert order.status == "COMPLETED"
    assert (account.status, account.inventory_status) == ("SOLD", "OUT_OF_STOCK")
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == 120
    current_pending = seeded_db.scalar(select(Notification).where(Notification.recipient_user_id == operator.id, Notification.notification_type == "PROFIT_PENDING", Notification.entity_id == order.order_no))
    assert current_pending.read_at is None
    set_allocations(seeded_db, order.id, items=[{"user_id": operator.id, "role": "OWNER", "allocation_rate": "100"}], actor="pytest")
    group = next(group for group in r3_commission_reconciliation(seeded_db)["order_groups"] if group["order_id"] == order.id)
    assert group["outbound_date"] == date(2026, 10, 31)
