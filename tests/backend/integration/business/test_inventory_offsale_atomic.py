"""INVENTORY-04 库存下架与关联平台事件保持原子性。"""

from datetime import date

import pytest
from sqlalchemy import select

from app.business import schemas
from app.business.shared.operations.consignment import platform_unlist_consignment, register_consignment
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.business.form_fields import create_order_form_field
from app.business.orders.routers.order_events_router import inventory_offsale
from app.core.errors import Validation
from app.core.database import get_db
from app.core.security import DEV_USERS
from app.domain.trade import Account, Cashflow, Order, OrderEvent, OrderFormField


def _conditional_receipt(seeded_db, scope, dependency):
    core = seeded_db.scalar(select(OrderFormField).where(
        OrderFormField.order_type_code == scope, OrderFormField.field_key == dependency,
    ))
    if core is None:
        core = create_order_form_field(seeded_db, order_type_code=scope, field_key=dependency,
                                       label="依赖字段", actor="pytest")
        core.is_custom = False
        seeded_db.flush()
    create_order_form_field(
        seeded_db, order_type_code=scope, field_key="receipt", label="条件凭据", actor="pytest",
        required_when={"field": dependency, "op": "filled"},
    )


@pytest.mark.parametrize("dependency", ["platform_ids", "operator_user_ids"])
def test_consignment_conditions_use_selected_platform_and_operators(seeded_db, seeded_client, headers, dependency):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": f"consignment-condition-{dependency}"})
    _conditional_receipt(seeded_db, "CONSIGN", dependency)
    seeded_db.commit()
    url = f"/api/orders/{order.id}/events"
    payload = {"event_type": "OPERATE", "operation_type": "CONSIGNMENT", "occurred_on": "2026-11-02",
               "operator_user_ids": [1], "form_extra": {"consignment_platforms": ["测试平台"]}}
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422 and "条件凭据" in missing.text
    spoofed = seeded_client.post(url, json={**payload, "form_extra": {**payload["form_extra"], dependency: []}}, headers=headers)
    assert spoofed.status_code == 422 and "条件凭据" in spoofed.text
    saved = seeded_client.post(url, json={**payload, "form_extra": {**payload["form_extra"], "receipt": "凭据A"}}, headers=headers)
    assert saved.status_code == 201, saved.text
    assert saved.json()["event"]["form_extra"]["receipt"] == "凭据A"


@pytest.mark.parametrize(("order_type", "amount", "dependency"), [
    ("HS", "0", "reason"), ("HS", "30", "reason"), ("TH", "0", "reason"),
    ("TH", "30", "reason"), ("DG", None, "reason"),
    ("HS", "30", "amount"), ("DG", None, "listing_id"),
])
def test_inventory_cancellation_conditions_use_parent_form_values(seeded_db, seeded_client, headers, order_type, amount, dependency):
    order = create_order(seeded_db, order_type=order_type, trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": f"condition-{order_type}-{amount}"})
    buy = None
    if order_type != "DG":
        buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100",
                            occurred_on=date(2026, 11, 1), actor="pytest")
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
                         form_extra={"consignment_platforms": ["测试平台"]})
    scope = "INVOID" if order_type == "DG" else "INVREFUND"
    _conditional_receipt(seeded_db, scope, dependency)
    seeded_db.commit()
    payload = {"reason": "取消交易", "occurred_on": "2026-11-02", "unlisted_at": "2026-11-02T12:00"}
    if amount is not None:
        payload["amount"] = amount
    if buy is not None and amount != "0":
        payload.update(pool_id=buy.pool_id, offset_event_id=buy.id)
    url = f"/api/orders/{order.id}/inventory-offsale"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "条件凭据" in missing.text
    assert seeded_db.get(Order, order.id).status == "ACTIVE"
    spoofed = seeded_client.post(url, json={**payload, "form_extra": {dependency: ""}}, headers=headers)
    assert spoofed.status_code == 422 and "条件凭据" in spoofed.text
    saved = seeded_client.post(url, json={**payload, "form_extra": {"receipt": "凭据A"}}, headers=headers)
    assert saved.status_code == 200, saved.text
    assert seeded_db.get(Order, order.id).form_extra["receipt"] == "凭据A"


def test_plain_order_cancellation_conditions_use_reason(seeded_db, seeded_client, headers):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": "plain-conditional-cancel"})
    _conditional_receipt(seeded_db, "ORDERCANC", "reason")
    seeded_db.commit()
    url = f"/api/orders/{order.id}/cancel"
    missing = seeded_client.post(url, json={"reason": "取消交易"}, headers=headers)
    assert missing.status_code == 422 and "条件凭据" in missing.text
    saved = seeded_client.post(url, json={"reason": "取消交易", "form_extra": {"receipt": "凭据A"}}, headers=headers)
    assert saved.status_code == 200, saved.text
    assert seeded_db.get(Order, order.id).form_extra["receipt"] == "凭据A"


def test_inventory_refund_records_selected_operators(seeded_db, seeded_client, headers):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": "refund-operators"})
    buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100",
                        occurred_on=date(2026, 11, 1), actor="pytest")
    seeded_db.commit()
    response = seeded_client.post(f"/api/orders/{order.id}/inventory-offsale", headers=headers, json={
        "reason": "取消交易", "amount": "30", "pool_id": buy.pool_id, "offset_event_id": buy.id,
        "occurred_on": "2026-11-02", "unlisted_at": "2026-11-02T12:00", "operator_user_ids": [1, 2],
    })
    assert response.status_code == 200, response.text
    refund = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "CANCEL"))
    assert refund.operator_user_ids == [1, 2]
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.source_id == refund.event_no))
    assert flow is not None and flow.operator_user_ids == [1, 2]


@pytest.mark.parametrize(("is_sale", "dependency"), [
    (False, "reason"), (False, "refund_amount"), (True, "amount"), (True, "cancel_amount"),
])
def test_cancel_event_conditions_use_reason_and_amount(seeded_db, seeded_client, headers, is_sale, dependency):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": f"conditional-event-{is_sale}"})
    buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    source = buy
    if is_sale:
        source, _ = post_event(seeded_db, order.id, event_type="SELL", amount="200",
                               occurred_on=date(2026, 11, 1), actor="pytest")
    _conditional_receipt(seeded_db, "ORDERCANC" if is_sale else "INVREFUND", dependency)
    seeded_db.commit()
    payload = {"event_type": "CANCEL", "amount": "30", "occurred_on": "2026-11-02", "reason": "取消交易",
               "offset_event_id": source.id, "pool_id": source.pool_id, "finalize_sale_cancel": is_sale}
    url = f"/api/orders/{order.id}/events"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422 and "条件凭据" in missing.text
    saved = seeded_client.post(url, json={**payload, "form_extra": {"receipt": "凭据A"}}, headers=headers)
    assert saved.status_code == 201, saved.text
    assert saved.json()["event"]["form_extra"]["receipt"] == "凭据A"


@pytest.mark.parametrize("dependency", ["reason", "listing_id", "unlisted_at"])
def test_platform_unlist_conditions_use_original_form_values(seeded_db, seeded_client, headers, dependency):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": f"platform-condition-{dependency}"})
    listing, _ = register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
                                      form_extra={"consignment_platforms": ["测试平台"]})
    _conditional_receipt(seeded_db, "INVOID", dependency)
    seeded_db.commit()
    payload = {"event_type": "OPERATE", "operation_type": "UNLIST", "occurred_on": "2026-11-02", "reason": "平台下架",
               "form_extra": {"consignment_event_id": listing.id, "consignment_platforms": ["测试平台"],
                              "platform_unlisted_at": "2026-11-02T12:00", "platform_unlist_scope": "PLATFORM"}}
    url = f"/api/orders/{order.id}/events"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422 and "条件凭据" in missing.text
    saved = seeded_client.post(url, json={**payload, "form_extra": {**payload["form_extra"], "receipt": "凭据A"}}, headers=headers)
    assert saved.status_code == 201, saved.text
    assert saved.json()["event"]["form_extra"]["receipt"] == "凭据A"


@pytest.mark.parametrize(("order_type", "amount", "scope", "other_scope"), [
    ("HS", "0", "INVREFUND", "INVOID"),
    ("HS", "30", "INVREFUND", "INVOID"),
    ("DG", None, "INVOID", "INVREFUND"),
])
def test_offsale_uses_its_own_custom_fields(seeded_db, seeded_client, headers, order_type, amount, scope, other_scope):
    order = create_order(seeded_db, order_type=order_type, trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": f"fields-{order_type}-{amount}"})
    buy = None
    if order_type == "HS":
        buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100",
                            occurred_on=date(2026, 11, 1), actor="pytest")
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
                         form_extra={"consignment_platforms": ["测试平台"]})
    for field_scope, key, label in [(scope, "receipt", "取消凭据"), (other_scope, "other", "其他操作凭据")]:
        create_order_form_field(seeded_db, order_type_code=field_scope, field_key=key,
                                label=label, required=True, actor="pytest")
    seeded_db.commit()
    payload = {"reason": "取消", "occurred_on": "2026-11-02", "unlisted_at": "2026-11-02T12:00"}
    if amount is not None:
        payload["amount"] = amount
    if buy is not None and amount != "0":
        payload.update(pool_id=buy.pool_id, offset_event_id=buy.id)
    url = f"/api/orders/{order.id}/inventory-offsale"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "取消凭据" in missing.text
    assert seeded_db.get(Order, order.id).status == "ACTIVE"
    done = seeded_client.post(url, json={**payload, "form_extra": {"receipt": "凭据A"}}, headers=headers)
    assert done.status_code == 200, done.text
    assert seeded_db.get(Order, order.id).form_extra["receipt"] == "凭据A"


def test_plain_order_cancel_cannot_skip_required_fields(seeded_db, seeded_client, headers):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": "plain-cancel-fields"})
    create_order_form_field(seeded_db, order_type_code="ORDERCANC", field_key="receipt",
                            label="取消凭据", required=True, actor="pytest")
    seeded_db.commit()
    url = f"/api/orders/{order.id}/cancel"
    missing = seeded_client.post(url, json={"reason": "取消", "form_extra_scope": "REFUND"}, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "取消凭据" in missing.text
    assert seeded_db.get(Order, order.id).status == "ACTIVE"
    done = seeded_client.post(url, json={"reason": "取消", "form_extra_scope": "REFUND",
                                        "form_extra": {"receipt": "凭据A"}}, headers=headers)
    assert done.status_code == 200, done.text
    assert seeded_db.get(Order, order.id).form_extra["receipt"] == "凭据A"


def test_sale_cancel_event_cannot_change_field_scope(seeded_db, seeded_client, headers):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": "cancel-sale-fields"})
    post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    sale, _ = post_event(seeded_db, order.id, event_type="SELL", sale_mode="FULL", amount="200",
                         occurred_on=date(2026, 11, 1), actor="pytest")
    create_order_form_field(seeded_db, order_type_code="ORDERCANC", field_key="receipt",
                            label="取消凭据", required=True, actor="pytest")
    seeded_db.commit()
    payload = {"event_type": "CANCEL", "finalize_sale_cancel": True, "amount": "50",
               "occurred_on": "2026-11-02", "offset_event_id": sale.id, "pool_id": sale.pool_id,
               "reason": "退货", "form_extra_scope": "REFUND"}
    url = f"/api/orders/{order.id}/events"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "取消凭据" in missing.text
    done = seeded_client.post(url, json={**payload, "form_extra": {"receipt": "凭据A"}}, headers=headers)
    assert done.status_code == 201, done.text
    assert done.json()["event"]["form_extra"]["receipt"] == "凭据A"


def test_consignment_event_cannot_change_field_scope(seeded_db, seeded_client, headers):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
                         actor="pytest", account_snapshot={"game_account": "consignment-fields"})
    create_order_form_field(seeded_db, order_type_code="CONSIGN", field_key="receipt",
                            label="上架凭据", required=True, actor="pytest")
    seeded_db.commit()
    payload = {"event_type": "OPERATE", "operation_type": "CONSIGNMENT", "occurred_on": "2026-11-02",
               "form_extra_scope": "REFUND", "form_extra": {"consignment_platforms": ["测试平台"]}}
    url = f"/api/orders/{order.id}/events"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "上架凭据" in missing.text
    done = seeded_client.post(url, json={**payload, "form_extra": {**payload["form_extra"], "receipt": "凭据A"}}, headers=headers)
    assert done.status_code == 201, done.text
    assert done.json()["event"]["form_extra"]["receipt"] == "凭据A"


def test_failed_system_offsale_rolls_back_platform_events(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-offsale", "game_type": "王者荣耀"})
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    seeded_db.commit()
    order_id, account_id = order.id, order.account_id
    payload = schemas.InventoryOffsaleIn(reason=" ", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00")
    with pytest.raises(Validation):
        inventory_offsale(order_id, payload, seeded_db, DEV_USERS["admin"])
    seeded_db.rollback()
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert all((event.form_extra or {}).get("operation_type") != "UNLIST" for event in events)
    assert seeded_db.get(Order, order_id).status == "ACTIVE"
    assert seeded_db.get(Account, account_id).status == "WAITING"


def test_system_offsale_cancels_order_and_unlists_platform(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-success", "game_type": "王者荣耀"})
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    payload = schemas.InventoryOffsaleIn(reason="结束代挂", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00")
    assert inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"]) == {"ok": True}
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    unlisted = [event for event in events if (event.form_extra or {}).get("operation_type") == "UNLIST"]
    assert len(unlisted) == 1
    assert unlisted[0].form_extra["platform_unlisted_at"] == "2026-11-02T12:00"
    assert order.status == "CANCELLED"
    assert seeded_db.get(Account, order.account_id).status == "VOID"


def test_system_offsale_does_not_repeat_whitespace_platform_unlisting(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "whitespace-offsale", "game_type": "王者荣耀"})
    listing, _ = register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": [" 测试平台 "]})
    platform_unlist_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 2), actor="pytest",
        form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["测试平台"]})
    payload = schemas.InventoryOffsaleIn(reason="结束代挂", occurred_on=date(2026, 11, 3), unlisted_at="2026-11-03T12:00")
    inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"])
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    unlisted = [event for event in events if (event.form_extra or {}).get("operation_type") == "UNLIST"]
    assert len(unlisted) == 1
    assert order.status == "CANCELLED"


def test_other_platform_unlisting_does_not_hide_remaining_platform(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "renamed-platform", "game_type": "王者荣耀"})
    listing, _ = register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["旧平台"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 11, 1),
        actor="pytest", form_extra={"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": ["旧平台"]})
    listing.form_extra = {**listing.form_extra, "consignment_platforms": ["新平台"]}
    seeded_db.flush()
    payload = schemas.InventoryOffsaleIn(reason="结束代挂", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00")
    inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"])
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    assert sum((event.form_extra or {}).get("operation_type") == "UNLIST" for event in events) == 2


def test_recovery_offsale_rolls_back_unlisting_when_refund_invalid(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-recovery", "game_type": "王者荣耀"})
    buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    seeded_db.commit()
    order_id, account_id, buy_id = order.id, order.account_id, buy.id
    payload = schemas.InventoryOffsaleIn(reason="出库", occurred_on=date(2026, 11, 2),
        unlisted_at="2026-11-02T12:00", amount="200", pool_id=buy.pool_id, offset_event_id=buy_id)
    with pytest.raises(Validation):
        inventory_offsale(order_id, payload, seeded_db, DEV_USERS["admin"])
    seeded_db.rollback()
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert all((event.form_extra or {}).get("operation_type") != "UNLIST" for event in events)
    assert seeded_db.get(Account, account_id).status == "WAITING"


def test_recovery_offsale_unlists_and_reverses_buy(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-recovery-success", "game_type": "王者荣耀"})
    buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    payload = schemas.InventoryOffsaleIn(reason="出库", occurred_on=date(2026, 11, 2),
        unlisted_at="2026-11-02T12:00", amount="100", pool_id=buy.pool_id, offset_event_id=buy.id)
    assert inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"]) == {"ok": True}
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    unlisting = next(event for event in events if (event.form_extra or {}).get("operation_type") == "UNLIST")
    assert unlisting.form_extra["platform_unlist_scope"] == "PLATFORM"
    assert unlisting.form_extra["consignment_platforms"] == ["测试平台"]
    assert any(event.event_type == "CANCEL" and event.offset_event_id == buy.id for event in events)
    assert seeded_db.get(Account, order.account_id).status == "VOID"


def test_recovery_cancellation_with_partial_refund_exits_inventory(seeded_db):
    from app.business.orders.router_output import _order_list_payload
    from app.shared.order_amounts import order_cashflow_profit_by_order
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1), actor="pytest", account_snapshot={"game_account": "partial-cancel", "game_type": "王者荣耀"})
    buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    seeded_db.add_all([
        Cashflow(flow_no="CF-CANCEL-OTHER-IN", pool_id=buy.pool_id, occurred_on=date(2026, 11, 1), direction="IN", category="OTHER", amount=40, order_id=order.id, created_by="pytest", updated_by="pytest"),
        Cashflow(flow_no="CF-CANCEL-OTHER-OUT", pool_id=buy.pool_id, occurred_on=date(2026, 11, 1), direction="OUT", category="OTHER", amount=10, order_id=order.id, created_by="pytest", updated_by="pytest"),
    ])
    seeded_db.flush()
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest", form_extra={"consignment_platforms": ["测试平台"]})
    payload = schemas.InventoryOffsaleIn(reason="取消入库", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00", amount="80", pool_id=buy.pool_id, offset_event_id=buy.id)
    assert inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"]) == {"ok": True}
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    assert sum((event.form_extra or {}).get("operation_type") == "UNLIST" for event in events) == 1
    cancel = next(event for event in events if event.event_type == "CANCEL")
    assert cancel.amount == 80 and cancel.offset_event_id == buy.id
    assert seeded_db.get(Account, order.account_id).status == "VOID"
    assert seeded_db.get(Account, order.account_id).cost_amount == 20
    assert order.status == "CANCELLED"
    seeded_db.flush()
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == 10
    assert _order_list_payload(seeded_db, [order])[0]["profit_base"] == 10


@pytest.mark.parametrize("has_buy", [False, True])
def test_unsold_cancellation_without_refund_keeps_existing_finance(seeded_db, has_buy):
    from app.shared.order_amounts import order_cashflow_profit_by_order
    order = create_order(seeded_db, order_type="TH", trade_date=date(2026, 11, 1), actor="pytest", account_snapshot={"game_account": f"zero-cancel-{has_buy}", "game_type": "王者荣耀"})
    if has_buy:
        post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    payload = schemas.InventoryOffsaleIn(reason="取消交易", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00", amount="0")
    assert inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"]) == {"ok": True}
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    assert sum(event.event_type == "BUY" for event in events) == int(has_buy)
    assert all(event.event_type != "CANCEL" for event in events)
    assert seeded_db.get(Account, order.account_id).status == "VOID"
    assert order.status == "CANCELLED"
    seeded_db.flush()
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id]).get(order.id, 0) == (-100 if has_buy else 0)


def test_http_failure_rolls_back_and_retry_succeeds(seeded_db, seeded_client, headers):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-http", "game_type": "王者荣耀"})
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    seeded_db.commit()
    order_id = order.id

    def transactional_db():
        try:
            yield seeded_db
            seeded_db.commit()
        except Exception:
            seeded_db.rollback()
            raise

    seeded_client.app.dependency_overrides[get_db] = transactional_db
    payload = {"reason": " ", "occurred_on": "2026-11-02", "unlisted_at": "2026-11-02T12:00"}
    response = seeded_client.post(f"/api/orders/{order_id}/inventory-offsale", json=payload, headers=headers)
    assert response.status_code >= 400
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert all((event.form_extra or {}).get("operation_type") != "UNLIST" for event in events)
    payload["reason"] = "结束代挂"
    response = seeded_client.post(f"/api/orders/{order_id}/inventory-offsale", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert seeded_db.get(Order, order_id).status == "CANCELLED"
    response = seeded_client.post(f"/api/orders/{order_id}/inventory-offsale", json=payload, headers=headers)
    assert response.status_code >= 400
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert sum((event.form_extra or {}).get("operation_type") == "UNLIST" for event in events) == 1


@pytest.mark.parametrize("timestamp", ["无效时间", "2026-11-03T12:00", "2026-11-02T12:00+08:00"])
def test_http_rejects_invalid_offsale_timestamp(seeded_db, seeded_client, headers, timestamp):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "invalid-offsale-time", "game_type": "王者荣耀"})
    response = seeded_client.post(f"/api/orders/{order.id}/inventory-offsale", headers=headers,
        json={"reason": "结束代挂", "occurred_on": "2026-11-02", "unlisted_at": timestamp})
    assert response.status_code in (400, 422)
    assert order.status == "ACTIVE"


def test_http_requires_order_update_permission(seeded_db, seeded_client):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "off-sale-no-permission", "game_type": "王者荣耀"})
    response = seeded_client.post(f"/api/orders/{order.id}/inventory-offsale",
        headers={"X-Dev-User": "finance"}, json={"reason": "结束代挂", "occurred_on": "2026-11-02", "unlisted_at": "2026-11-02T12:00"})
    assert response.status_code == 403
    assert order.status == "ACTIVE"
