"""API-01 订单详情编辑接口的账号、事件与资金契约。"""

from datetime import date
from decimal import Decimal
import pytest

from sqlalchemy import select

from app.business.stocks.profile import create_account
from app.domain.foundation import AuditLog
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Order, OrderEvent
from app.business.create import create_order
from app.business.events import post_event


def test_new_unlisting_requires_valid_active_listing_and_stores_event_id(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="select-active-listing", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    def submit(extra):
        return seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [], "new_events": [{"operation_type": "UNLIST", "occurred_at": "2026-10-02T11:00:00", "form_extra": extra}]})
    assert submit({"platform_unlist_scope": "PLATFORM", "consignment_platforms": ["平台甲"]}).status_code == 422
    assert submit({"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": ["平台乙"]}).status_code == 422
    valid = {"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": ["平台甲"]}
    assert submit(valid).status_code == 200
    assert submit(valid).status_code == 422
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    assert sum((e.form_extra or {}).get("operation_type") == "UNLIST" for e in events) == 1


def test_detail_unlisting_normalizes_platform_before_saving(seeded_client, seeded_db, headers):
    from app.business.listing_state import active_listings
    account = create_account(seeded_db, game_account="whitespace-platform-unlisting", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    url = f"/api/v1/orders/{order.id}/execution-edit"
    def submit(platform):
        return seeded_client.patch(url, headers=headers, json={"events": [], "new_events": [{"operation_type": "UNLIST", "occurred_at": "2026-10-02T11:00:00", "form_extra": {"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": [platform]}}]})
    assert submit(" 平台甲 ").status_code == 200
    event = next(event for event in seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all() if (event.form_extra or {}).get("operation_type") == "UNLIST")
    assert event.form_extra["consignment_platforms"] == ["平台甲"]
    assert active_listings(seeded_db, order.id) == set()
    assert submit("平台甲").status_code == 422


def test_cannot_relist_platform_before_it_is_unlisted(seeded_db):
    from app.core.errors import Validation
    account = create_account(seeded_db, game_account="duplicate-platform", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    with pytest.raises(Validation):
        post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 2), actor="pytest", form_extra={"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": ["平台甲"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 3), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})


def test_edit_listing_cannot_change_to_another_active_platform(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-duplicate-listing", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    first, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台乙"]})
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": first.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["平台乙"]}}]})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("new_type", ["DESCRIPTION", "UNLIST", None])
def test_existing_listing_operation_type_cannot_be_changed(seeded_client, seeded_db, headers, new_type):
    from app.business.listing_state import active_listings
    account = create_account(seeded_db, game_account="edit-operation-type", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    extra = {"consignment_platforms": ["平台甲"]}
    if new_type is not None:
        extra["operation_type"] = new_type
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": extra}]})
    assert response.status_code == 422, response.text
    assert active_listings(seeded_db, order.id) == {(listing.id, "平台甲")}


@pytest.mark.parametrize("change", [
    {"consignment_platforms": ["平台乙"]},
    {"platform_unlist_scope": "SYSTEM"},
    {"consignment_event_id": None},
    {"operation_type": "DESCRIPTION"},
])
def test_linked_unlisting_target_cannot_be_changed(seeded_client, seeded_db, headers, change):
    account = create_account(seeded_db, game_account="locked-unlisting", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    extra = {"operation_type": "UNLIST", "consignment_event_id": listing.id, "consignment_platforms": ["平台甲"], "platform_unlist_scope": "PLATFORM"}
    unlisting, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 2), actor="pytest", form_extra=extra)
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": unlisting.id, "expected_amount": "0", "amount": "0", "form_extra": {**extra, **change}}]})
    assert response.status_code == 422, response.text


def test_linked_unlisting_time_remains_editable(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-unlisting-time", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    unlisting, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 2), actor="pytest", form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["平台甲"], "platform_unlist_scope": "PLATFORM"})
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": unlisting.id, "expected_amount": "0", "amount": "0", "occurred_at": "2026-10-03T11:00:00"}]})
    assert response.status_code == 200, response.text
    seeded_db.refresh(unlisting)
    assert unlisting.occurred_on == date(2026, 10, 3)


@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_detail_edit_cannot_create_system_unlisting(seeded_client, seeded_db, headers, order_type):
    inventory_type = {"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}[order_type]
    account = create_account(seeded_db, game_account=f"system-unlist-{order_type}", business_mode="SELF" if order_type == "HS" else "DISTRIBUTION", inventory_type=inventory_type, actor="pytest")
    order = create_order(seeded_db, order_type=order_type, trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [], "new_events": [{"operation_type": "UNLIST", "occurred_at": "2026-10-02T11:00:00", "form_extra": {"platform_unlist_scope": "SYSTEM"}}]})
    assert response.status_code == 422, response.text


def test_single_event_endpoint_cannot_fake_system_unlisting(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="direct-system-unlist", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    response = seeded_client.post(f"/api/v1/orders/{order.id}/events", headers=headers, json={"event_type": "OPERATE", "operation_type": "UNLIST", "occurred_on": "2026-10-02", "form_extra": {"platform_unlist_scope": "SYSTEM"}})
    assert response.status_code == 422, response.text


def test_platform_unlisting_endpoint_requires_active_listing_on_same_order(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="api-platform-unlist", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    other_account = create_account(seeded_db, game_account="api-platform-other", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    other_order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=other_account.id)
    other_listing, _ = post_event(seeded_db, other_order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    def submit(extra):
        return seeded_client.post(f"/api/v1/orders/{order.id}/events", headers=headers, json={"event_type": "OPERATE", "operation_type": "UNLIST", "occurred_on": "2026-10-02", "reason": "平台停售", "form_extra": {"platform_unlist_scope": "PLATFORM", **extra}})
    assert submit({"consignment_event_id": 999999, "consignment_platforms": ["不存在的平台"]}).status_code == 422
    assert submit({"consignment_event_id": other_listing.id, "consignment_platforms": ["平台甲"]}).status_code == 422
    assert submit({"consignment_event_id": listing.id, "consignment_platforms": ["平台乙"]}).status_code == 422
    assert submit({"consignment_platforms": ["平台甲"]}).status_code == 422
    valid = {"consignment_event_id": listing.id, "consignment_platforms": ["平台甲"]}
    response = submit(valid)
    assert response.status_code == 201
    assert response.json()["event"]["reason"] == "平台停售"
    assert submit(valid).status_code == 422


@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_edit_platform_unlisting_cannot_be_changed_to_system(seeded_client, seeded_db, headers, order_type):
    account = create_account(seeded_db, game_account=f"edit-system-unlist-{order_type}", business_mode="SELF" if order_type == "HS" else "DISTRIBUTION", inventory_type={"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}[order_type], actor="pytest")
    order = create_order(seeded_db, order_type=order_type, trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    event, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"platform_unlist_scope": "PLATFORM", "consignment_platforms": ["平台甲"]})
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "UNLIST", "platform_unlist_scope": "SYSTEM"}}]})
    assert response.status_code == 422, response.text


def test_existing_system_unlisting_target_locked_but_time_editable(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="existing-system-unlist", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    event, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"platform_unlist_scope": "SYSTEM"})
    url = f"/api/v1/orders/{order.id}/execution-edit"
    response = seeded_client.patch(url, headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "UNLIST", "platform_unlist_scope": "PLATFORM", "consignment_platforms": ["平台甲"]}}]})
    assert response.status_code == 422, response.text
    response = seeded_client.patch(url, headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "occurred_at": "2026-10-03T11:00:00"}]})
    assert response.status_code == 200, response.text


def test_order_edit_updates_event_flow_and_cost_without_changing_time(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-inventory", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    original_time = event.occurred_on
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100.00", "amount": "150.00", "note": "修改"}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id).cost_amount == Decimal("150")
    edited = seeded_db.get(OrderEvent, event.id)
    assert edited.amount == Decimal("150") and edited.note == "修改" and edited.occurred_on == original_time
    flows = seeded_db.scalars(select(Cashflow).where(
        Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
    )).all()
    assert len(flows) == 1 and flows[0].amount == Decimal("150") and flows[0].occurred_on == original_time
    assert seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "inventory_event_edit", AuditLog.entity_id == str(event.id))) is not None


def test_operator_with_order_update_can_save_order_detail(seeded_client, seeded_db, operator_headers):
    from app.core.security import DEV_USERS

    account = create_account(seeded_db, game_account="operator-detail-edit", business_mode="SELF", inventory_type="RECOVERY", actor="operator")
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=date(2026, 10, 1),
        actor="operator",
        account_id=account.id,
        owner_id=DEV_USERS["operator"].id,
        user=DEV_USERS["operator"],
    )
    seeded_db.commit()

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=operator_headers,
        json={"profile": {"game_account": "operator-detail-edited"}, "events": []},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id).game_account == "operator-detail-edited"


def test_order_edit_saves_profile_and_amount_together(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="before-edit", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"profile": {"game_account": "after-edit"}, "events": [{"id": event.id, "expected_amount": "100", "amount": "150", "note": "ok"}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id).game_account == "after-edit"
    assert seeded_db.get(OrderEvent, event.id).amount == Decimal("150")


def test_stale_amount_rejects_whole_edit(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="stale-before", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"profile": {"game_account": "must-not-save"}, "events": [{"id": event.id, "expected_amount": "99", "amount": "150"}]})
    assert response.status_code == 409
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id).game_account == "stale-before"
    assert seeded_db.get(OrderEvent, event.id).amount == Decimal("100")


def test_cannot_edit_event_of_another_account(seeded_client, seeded_db, headers):
    first = create_account(seeded_db, game_account="first", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    second = create_account(seeded_db, game_account="second", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    first_order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=first.id)
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=second.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/orders/{first_order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "150"}]})
    assert response.status_code == 404
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).amount == Decimal("100")


def test_edit_execution_operator_preserves_time_and_records_actual_editor(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="operator-edit", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    timestamp = event.created_at
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "100", "operator_user_ids": [1, 2]}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    updated = seeded_db.get(OrderEvent, event.id)
    assert updated.created_by == "pytest" and updated.operator_user_ids == [1, 2] and updated.created_at == timestamp
    audit = seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "inventory_event_edit", AuditLog.entity_id == str(event.id)))
    assert audit.actor == "admin" and audit.before_json["operator_user_ids"] is None and audit.after_json["operator_user_ids"] == [1, 2]
    detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
    assert detail.status_code == 200
    shown = detail.json()["orders"][0]["events"][0]
    assert shown["operator_user_ids"] == [1, 2]
    assert shown["operator_names"] == ["种子用户1", "种子用户2"]


def test_edit_event_operator_updates_linked_cashflow_operators(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="sale-operator-flow-sync", business_mode="DISTRIBUTION", inventory_type="PICKUP", actor="pytest")
    order = create_order(seeded_db, order_type="TH", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("200"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
    flow = seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
    ))
    assert flow is not None

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [{"id": event.id, "expected_amount": "200.00", "amount": "200.00", "operator_user_ids": [1, 2]}]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).operator_user_ids == [1, 2]
    assert seeded_db.get(Cashflow, flow.id).operator_user_ids == [1, 2]
    detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
    assert detail.status_code == 200
    shown = detail.json()["detail_view"]["finance_rows"]
    assert any(row["operator_user_ids"] == [1, 2] for row in shown)


def test_order_detail_edit_updates_cashflow_operators(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="cashflow-operator-edit", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id))

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [], "cashflows": [{"flow_no": flow.flow_no, "operator_user_ids": [1, 2]}]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Cashflow, flow.id).operator_user_ids == [1, 2]
    detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
    assert detail.status_code == 200
    shown = detail.json()["detail_view"]["finance_rows"][0]
    assert shown["operator_user_ids"] == [1, 2]


def test_order_detail_edit_updates_cashflow_amount_and_pool(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="cashflow-amount-pool-edit", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id))
    target_pool = seeded_db.scalar(select(Pool).where(Pool.id != flow.pool_id, Pool.status == "ACTIVE").order_by(Pool.id))
    assert flow is not None and target_pool is not None

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [], "cashflows": [{"flow_no": flow.flow_no, "amount": "88.50", "pool_id": target_pool.id}]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    edited = seeded_db.get(Cashflow, flow.id)
    assert edited.amount == Decimal("88.50")
    assert edited.pool_id == target_pool.id
    detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
    assert detail.status_code == 200
    shown = detail.json()["detail_view"]["finance_rows"][0]
    assert shown["amount"] == "88.50"
    assert shown["pool_id"] == target_pool.id


def test_edit_execution_operator_can_clear_all_selected_users(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="clear-event-operators", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    event.operator_user_ids = [1, 2]
    seeded_db.commit()

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [{"id": event.id, "expected_amount": "100", "amount": "100", "operator_user_ids": []}]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).operator_user_ids == []


def test_operator_selection_rejects_unknown_users(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="unknown-operator", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "100", "operator_user_ids": [999999]}]})
    assert response.status_code == 422
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).operator_user_ids is None


def test_zero_amount_execution_can_change_operators_without_cashflow(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="zero-event", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    event = OrderEvent(order_id=order.id, event_no="ZERO-OP-001", event_type="DELIVER", amount=Decimal("0"), portion="GROSS", occurred_on=date(2026, 10, 1), is_posted=True, created_by="pytest", updated_by="pytest")
    seeded_db.add(event)
    seeded_db.commit()
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "operator_user_ids": [1, 2]}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).operator_user_ids == [1, 2]


def test_operator_edit_does_not_change_existing_cashflow_amount(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="operator-flow", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    flow = seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
    ))
    flow.amount = Decimal("90")
    seeded_db.commit()
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "100", "operator_user_ids": [1, 2]}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Cashflow, flow.id).amount == Decimal("90")


def test_order_detail_edit_can_clear_order_note_and_business_operators(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="clear-order-fields", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    order.note = "旧备注"
    seeded_db.commit()

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [], "orders": [{"order_id": order.id, "form_extra": {"business_responsible_ids": []}, "note": None}]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    edited = seeded_db.get(Order, order.id)
    assert edited.created_by == "pytest"
    assert edited.form_extra["business_responsible_ids"] == []
    assert edited.note is None


def test_order_detail_edit_updates_inventory_operator_ids(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="inventory-operator-ids", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    order.form_extra = {"business_responsible_ids": [1]}
    seeded_db.commit()

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [], "orders": [{"order_id": order.id, "form_extra": {"business_responsible_ids": [1, 2]}}]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Order, order.id).form_extra["business_responsible_ids"] == [1, 2]
    detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
    assert detail.status_code == 200
    shown = detail.json()["orders"][0]
    assert shown["operator_user_ids"] == [1, 2]
    assert shown["operator"] == "种子用户1、种子用户2"


def test_order_detail_edit_rejects_unknown_inventory_operator(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="invalid-inventory-operator", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    order.form_extra = {"business_responsible_ids": [1]}
    seeded_db.commit()

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [], "orders": [{"order_id": order.id, "form_extra": {"business_responsible_ids": [999999]}}]},
    )

    assert response.status_code == 422, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Order, order.id).form_extra["business_responsible_ids"] == [1]


def test_order_detail_does_not_use_creator_as_inventory_operator(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="no-inventory-operator", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    seeded_db.commit()

    detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)

    assert detail.status_code == 200
    assert detail.json()["orders"][0]["operator"] == "-"


def test_order_detail_edit_can_add_platform_operation_row_with_its_own_time_and_price(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="add-platform-row", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    seeded_db.commit()

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [], "new_events": [{
            "operation_type": "CONSIGNMENT",
            "occurred_at": "2026-10-03T12:34:00",
            "operator_user_ids": [1],
            "form_extra": {"consignment_platforms": ["千寻"], "consignment_price": 123.45},
        }]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "OPERATE"))
    assert event is not None
    assert event.form_extra["consignment_platforms"] == ["千寻"]
    assert event.form_extra["consignment_price"] == 123.45
    assert event.form_extra["listed_at"] == "2026-10-03T12:34:00"
    assert event.posted_at.isoformat() == "2026-10-03T12:34:00"


def test_order_detail_edit_keeps_new_time_when_platform_and_time_change_together(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-platform-row", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra_scope="CONSIGN", form_extra={"consignment_platforms": ["旧平台"], "listed_at": "2026-10-01T10:00:00"})
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "OPERATE"))

    response = seeded_client.patch(
        f"/api/v1/orders/{order.id}/execution-edit",
        headers=headers,
        json={"events": [{
            "id": event.id,
            "expected_amount": "0.00",
            "amount": "0.00",
            "occurred_at": "2026-10-02T11:20:00",
            "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["新平台"]},
        }]},
    )

    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    edited = seeded_db.get(OrderEvent, event.id)
    assert edited.form_extra["consignment_platforms"] == ["新平台"]
    assert edited.form_extra["listed_at"] == "2026-10-02T11:20:00"
    assert edited.posted_at.isoformat() == "2026-10-02T11:20:00"


def test_edit_single_listed_platform_updates_linked_unlist(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-linked-platform", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["旧平台"]})
    unlisting, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["旧平台"], "platform_unlist_scope": "PLATFORM"})
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": [" 新平台 "]}}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, unlisting.id).form_extra["consignment_platforms"] == ["新平台"]


def test_edit_listing_with_whitespace_updates_linked_unlisting(seeded_client, seeded_db, headers):
    from app.business.consignment import platform_unlist_consignment
    from app.business.listing_state import active_listings
    account = create_account(seeded_db, game_account="edit-whitespace-platform", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": [" 旧平台 "]})
    unlisting, _ = platform_unlist_consignment(seeded_db, order.id, occurred_on=date(2026, 10, 2), actor="pytest", form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["旧平台"]})
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["新平台"]}}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, unlisting.id).form_extra["consignment_platforms"] == ["新平台"]
    assert active_listings(seeded_db, order.id) == set()


def test_cannot_reduce_partially_unlisted_multi_platform_record(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-multi-platform", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲", "平台乙"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["平台甲"], "platform_unlist_scope": "PLATFORM"})
    response = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["平台乙"]}}]})
    assert response.status_code == 422, response.text
    assert seeded_db.get(OrderEvent, listing.id).form_extra["consignment_platforms"] == ["平台甲", "平台乙"]
