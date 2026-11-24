"""API-01 订单详情编辑的上架和下架事件契约。"""

from datetime import date

import pytest
from sqlalchemy import select

from app.business.inventory.profile import create_account
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.domain.trade import OrderEvent

pytestmark = pytest.mark.db


def test_new_unlisting_requires_valid_active_listing_and_stores_event_id(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="select-active-listing", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    def submit(extra):
        return seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [], "new_events": [{"operation_type": "UNLIST", "occurred_at": "2026-10-02T11:00:00", "form_extra": extra}]})
    assert submit({"platform_unlist_scope": "PLATFORM", "consignment_platforms": ["平台甲"]}).status_code == 422
    assert submit({"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": ["平台乙"]}).status_code == 422
    valid = {"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": ["平台甲"]}
    assert submit(valid).status_code == 200
    assert submit(valid).status_code == 422
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    assert sum((e.form_extra or {}).get("operation_type") == "UNLIST" for e in events) == 1



def test_detail_unlisting_normalizes_platform_before_saving(seeded_client, seeded_db, headers):
    from app.business.shared.listing_state import active_listings
    account = create_account(seeded_db, game_account="whitespace-platform-unlisting", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    url = f"/api/orders/{order.id}/execution-edit"
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



def test_duplicate_platforms_in_single_listing_rejected_on_create_and_edit(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="duplicate-single-listing", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    duplicate = ["平台甲", " 平台甲 "]
    create = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [], "new_events": [{"operation_type": "CONSIGNMENT", "occurred_at": "2026-10-02T11:00:00", "form_extra": {"consignment_platforms": duplicate}}]})
    assert create.status_code == 422, create.text
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台乙"]})
    edit = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": duplicate}}]})
    assert edit.status_code == 422, edit.text



def test_edit_listing_cannot_change_to_another_active_platform(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-duplicate-listing", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    first, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台乙"]})
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": first.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["平台乙"]}}]})
    assert response.status_code == 422, response.text



@pytest.mark.parametrize("new_type", ["DESCRIPTION", "UNLIST", None])
def test_existing_listing_operation_type_cannot_be_changed(seeded_client, seeded_db, headers, new_type):
    from app.business.shared.listing_state import active_listings
    account = create_account(seeded_db, game_account="edit-operation-type", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    extra = {"consignment_platforms": ["平台甲"]}
    if new_type is not None:
        extra["operation_type"] = new_type
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": extra}]})
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
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": unlisting.id, "expected_amount": "0", "amount": "0", "form_extra": {**extra, **change}}]})
    assert response.status_code == 422, response.text



def test_unlinked_unlisting_cannot_gain_listing_association(seeded_client, seeded_db, headers):
    from app.business.shared.listing_state import active_listings
    account = create_account(seeded_db, game_account="edit-unlinked-unlisting", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    unlisting, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 2), actor="pytest", form_extra={"platform_unlist_scope": "PLATFORM", "consignment_platforms": ["平台甲"]})
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": unlisting.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "UNLIST", "platform_unlist_scope": "PLATFORM", "consignment_platforms": ["平台甲"], "consignment_event_id": listing.id}}]})
    assert response.status_code == 422, response.text
    assert active_listings(seeded_db, order.id) == {(listing.id, "平台甲")}



def test_linked_unlisting_time_remains_editable(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-unlisting-time", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    unlisting, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 2), actor="pytest", form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["平台甲"], "platform_unlist_scope": "PLATFORM"})
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": unlisting.id, "expected_amount": "0", "amount": "0", "occurred_at": "2026-10-03T11:00:00"}]})
    assert response.status_code == 200, response.text
    seeded_db.refresh(unlisting)
    assert unlisting.occurred_on == date(2026, 10, 3)



@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_detail_edit_cannot_create_system_unlisting(seeded_client, seeded_db, headers, order_type):
    inventory_type = {"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}[order_type]
    account = create_account(seeded_db, game_account=f"system-unlist-{order_type}", business_mode="SELF" if order_type == "HS" else "DISTRIBUTION", inventory_type=inventory_type, actor="pytest")
    order = create_order(seeded_db, order_type=order_type, trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [], "new_events": [{"operation_type": "UNLIST", "occurred_at": "2026-10-02T11:00:00", "form_extra": {"platform_unlist_scope": "SYSTEM"}}]})
    assert response.status_code == 422, response.text



def test_single_event_endpoint_cannot_fake_system_unlisting(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="direct-system-unlist", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    response = seeded_client.post(f"/api/orders/{order.id}/events", headers=headers, json={"event_type": "OPERATE", "operation_type": "UNLIST", "occurred_on": "2026-10-02", "form_extra": {"platform_unlist_scope": "SYSTEM"}})
    assert response.status_code == 422, response.text



def test_platform_unlisting_endpoint_requires_active_listing_on_same_order(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="api-platform-unlist", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    other_account = create_account(seeded_db, game_account="api-platform-other", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    other_order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=other_account.id)
    other_listing, _ = post_event(seeded_db, other_order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})
    def submit(extra):
        return seeded_client.post(f"/api/orders/{order.id}/events", headers=headers, json={"event_type": "OPERATE", "operation_type": "UNLIST", "occurred_on": "2026-10-02", "reason": "平台停售", "form_extra": {"platform_unlist_scope": "PLATFORM", **extra}})
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
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "UNLIST", "platform_unlist_scope": "SYSTEM"}}]})
    assert response.status_code == 422, response.text



def test_existing_system_unlisting_target_locked_but_time_editable(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="existing-system-unlist", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    event, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"platform_unlist_scope": "SYSTEM"})
    url = f"/api/orders/{order.id}/execution-edit"
    response = seeded_client.patch(url, headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "UNLIST", "platform_unlist_scope": "PLATFORM", "consignment_platforms": ["平台甲"]}}]})
    assert response.status_code == 422, response.text
    response = seeded_client.patch(url, headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "occurred_at": "2026-10-03T11:00:00"}]})
    assert response.status_code == 200, response.text



def test_order_detail_edit_can_add_platform_operation_row_with_its_own_time_and_price(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="add-platform-row", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    seeded_db.commit()

    response = seeded_client.patch(
        f"/api/orders/{order.id}/execution-edit",
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
        f"/api/orders/{order.id}/execution-edit",
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
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": [" 新平台 "]}}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, unlisting.id).form_extra["consignment_platforms"] == ["新平台"]



def test_edit_listing_with_whitespace_updates_linked_unlisting(seeded_client, seeded_db, headers):
    from app.business.shared.operations.consignment import platform_unlist_consignment
    from app.business.shared.listing_state import active_listings
    account = create_account(seeded_db, game_account="edit-whitespace-platform", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": [" 旧平台 "]})
    unlisting, _ = platform_unlist_consignment(seeded_db, order.id, occurred_on=date(2026, 10, 2), actor="pytest", form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["旧平台"]})
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["新平台"]}}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, unlisting.id).form_extra["consignment_platforms"] == ["新平台"]
    assert active_listings(seeded_db, order.id) == set()



def test_listing_draft_conflict_checks_do_not_rescan_all_drafts(seeded_client, seeded_db, headers, monkeypatch):
    from app.business.shared.order_detail.editing.schemas import ExecutionEditItem

    account = create_account(seeded_db, game_account="listing-draft-scan", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listings = [post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": [f"原平台{i}"]})[0] for i in range(20)]
    drafts = [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": [f"新平台{i}"]}} for i, listing in enumerate(listings)]
    drafts += [{"id": 100000 + i, "expected_amount": "0", "amount": "0"} for i in range(100)]
    original_getattribute = ExecutionEditItem.__getattribute__
    reads = 0

    def count_reads(item, name):
        nonlocal reads
        if name == "id":
            reads += 1
        return original_getattribute(item, name)

    monkeypatch.setattr(ExecutionEditItem, "__getattribute__", count_reads)
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": drafts})
    assert response.status_code == 404, response.text
    assert reads < 1000, reads



def test_listing_drafts_reject_conflicting_new_platforms(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="listing-draft-collision", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    first, second = [post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": [name]})[0] for name in ("原甲", "原乙")]
    drafts = [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": [platform]}} for listing, platform in ((first, "新甲"), (second, " 新甲 "))]
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": drafts})
    assert response.status_code == 422, response.text
    assert "该平台已上架" in response.text



def test_inactive_listing_draft_does_not_mask_later_conflict(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="listing-inactive-draft", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    first, second = [post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": [name]})[0] for name in ("原甲", "原乙")]
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 2), actor="pytest", form_extra={"consignment_event_id": second.id, "consignment_platforms": ["原乙"], "platform_unlist_scope": "PLATFORM"})
    drafts = [
        {"id": first.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["新平台"]}},
        {"id": second.id, "expected_amount": "1", "amount": "1", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["新平台"]}},
    ]
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": drafts})
    assert response.status_code == 409, response.text
    assert "执行记录已被修改" in response.text



def test_repeated_listing_draft_is_rejected_before_platform_conflict(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="listing-duplicate-draft", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    first, second = [post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": [name]})[0] for name in ("原甲", "原乙")]
    drafts = [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": [platform]}} for listing, platform in ((first, "新甲"), (second, "其他"), (second, " 新甲 "))]
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": drafts})
    assert response.status_code == 422, response.text
    assert "同一执行记录不能重复修改" in response.text



def test_duplicate_drafts_for_same_listing_are_rejected_without_mutation(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="listing-self-duplicate-draft", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["原平台"]})
    drafts = [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": [platform]}} for platform in ("新甲", "新乙")]
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": drafts})
    assert response.status_code == 422, response.text
    assert "同一执行记录不能重复修改" in response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, listing.id).form_extra["consignment_platforms"] == ["原平台"]



def test_batch_linked_unlisting_conflict_matches_in_linear_time(seeded_client, seeded_db, headers, monkeypatch):
    from app.business.shared.order_detail.editing import events as editing_events

    account = create_account(seeded_db, game_account="linked-conflict-batch", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲"]})

    class LinkedEvent:
        reads = 0

        def __init__(self, event_id):
            self.event_id = event_id

        @property
        def id(self):
            type(self).reads += 1
            return self.event_id

    linked = [LinkedEvent(10000 + index) for index in range(200)]
    monkeypatch.setattr(editing_events, "_linked_unlistings", lambda _db, _event: linked)
    drafts = [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["平台乙"]}}]
    drafts.extend({"id": 20000 + index, "expected_amount": "0", "amount": "0"} for index in range(200))
    drafts.append({"id": 10199, "expected_amount": "0", "amount": "0"})
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": drafts})
    assert response.status_code == 422, response.text
    assert "不能同时编辑关联下架记录" in response.text
    assert LinkedEvent.reads <= 400



def test_cannot_reduce_partially_unlisted_multi_platform_record(seeded_client, seeded_db, headers):
    account = create_account(seeded_db, game_account="edit-multi-platform", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    listing, _ = post_event(seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_platforms": ["平台甲", "平台乙"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 10, 1), actor="pytest", form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["平台甲"], "platform_unlist_scope": "PLATFORM"})
    response = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{"id": listing.id, "expected_amount": "0", "amount": "0", "form_extra": {"operation_type": "CONSIGNMENT", "consignment_platforms": ["平台乙"]}}]})
    assert response.status_code == 422, response.text
    assert seeded_db.get(OrderEvent, listing.id).form_extra["consignment_platforms"] == ["平台甲", "平台乙"]
