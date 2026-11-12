"""QUALITY-01 QLT-01 质量扫描契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.core.security import CurrentUser, build_access_token
from app.domain.trade import Account, Cashflow, OrderEvent, RebateRecord
from app.orders.create import create_order
from app.orders.events import post_event
from app.quality import service


def test_quality_read_routes_publish_typed_response_models(app):
    paths = app.openapi()["paths"]

    assert paths["/api/v1/quality/exceptions"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/QualitySummaryOut"
    )
    assert paths["/api/v1/quality/metrics"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/QualityMetricsOut"
    )
    issue_list_schema = paths["/api/v1/quality/issues"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert issue_list_schema["$ref"].endswith("/QualityIssueListOut")


TODAY = date(2026, 10, 17)


def _order(db, *, order_type="TH", owner_id=None):
    return create_order(
        db, order_type=order_type, trade_date=TODAY, actor="pytest", owner_id=owner_id
    )


class TestQualityScan:
    def test_scan_and_record_persists_deduplicated_open_issues(self, seeded_db):
        order = _order(seeded_db, order_type="HS")
        event = OrderEvent(
            event_no="HS-SCAN-RECORD-EVENT",
            order_id=order.id,
            event_type="BUY",
            amount=Decimal("100"),
            portion="PRINCIPAL",
            occurred_on=TODAY,
            pool_id=None,
            is_posted=True,
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(event)
        seeded_db.flush()

        first = service.scan_and_record(seeded_db, actor="pytest")
        second = service.scan_and_record(seeded_db, actor="pytest")

        assert any(item.code == "EVENT_POOL_MISSING" for item in first)
        assert len(second) == 0
        assert len(
            service.list_issues(seeded_db, code="EVENT_POOL_MISSING")
        ) == 1

    def test_does_not_flag_inventory_account_link_on_th_order(self, seeded_db):
        account = Account(
            game_account="quality-link-account",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            status="SOLD",
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, order_type="TH")
        order.account_id = account.id
        seeded_db.flush()
        assert not any(
            row["code"] == "ORDER_ACCOUNT_LINK_INVALID"
            and row["entity_id"] == order.order_no
            for row in service.scan(seeded_db)
        )

    def test_th_purchase_does_not_create_removed_advance_issue(self, seeded_db):
        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
            occurred_on=TODAY, actor="pytest",
        )

        result = service.summary(seeded_db)
        assert all(row["code"] != "TH_UNCLOSED_ADVANCE" for row in result["items"])

    def test_detects_missing_event_cashflow_and_pool(self, seeded_db):
        order = _order(seeded_db, order_type="HS")
        event = OrderEvent(
            event_no="HS-TEST-EVENT",
            order_id=order.id,
            event_type="BUY",
            amount=Decimal("100"),
            portion="PRINCIPAL",
            occurred_on=TODAY,
            pool_id=None,
            is_posted=True,
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(event)
        seeded_db.flush()

        codes = {row["code"] for row in service.scan(seeded_db)}
        assert "EVENT_POOL_MISSING" in codes
        assert "EVENT_CASHFLOW_MISMATCH" in codes

    def test_detects_unpaired_transfer(self, seeded_db):
        seeded_db.add(
            Cashflow(
                flow_no="TR-BROKEN-OUT",
                pool_id=1,
                occurred_on=TODAY,
                nature="INTERNAL",
                category="TRANSFER",
                direction="OUT",
                amount=Decimal("100"),
                transfer_id="TR-BROKEN",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()
        codes = {row["code"] for row in service.scan(seeded_db)}
        assert "TRANSFER_UNPAIRED" in codes

    def test_negative_available_includes_balance_breakdown(self, seeded_db):
        seeded_db.add(
            Cashflow(
                flow_no="CF-QUALITY-NEGATIVE",
                pool_id=1,
                occurred_on=TODAY,
                nature="BUSINESS_OUT",
                category="TEST_EXPENSE",
                direction="OUT",
                amount=Decimal("120"),
                status="APPROVED",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()

        item = next(
            row for row in service.scan(seeded_db) if row["code"] == "NEGATIVE_AVAILABLE"
        )
        assert item["details"] == {
            "income": "0.00",
            "expense": "120.00",
            "transfer_in": "0.00",
            "transfer_out": "0.00",
            "cash_balance": "-120.00",
            "deposit_held": "0.00",
            "available": "-120.00",
        }

    def test_no_unlinked_rebate_issue_with_source_order(self, seeded_db):
        order = _order(seeded_db, order_type="DG")
        seeded_db.add(
            RebateRecord(
                rebate_no="RB-UNLINKED-1",
                source_order_id=order.id,
                rebate_type="SELL",
                rate=Decimal("10"),
                base_amount=Decimal("500"),
                link_status="UNLINKED",
                status="OPEN",
                collected_on=TODAY,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()

        issues = service.scan(seeded_db)
        assert all(row["code"] != "REBATE_UNLINKED" for row in issues)

    def test_quality_endpoint_respects_order_scope(self, seeded_client, seeded_db):
        mine = _order(seeded_db, owner_id=9)
        post_event(
            seeded_db, mine.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest",
        )
        other = _order(seeded_db, owner_id=8)
        post_event(
            seeded_db, other.id, event_type="BUY", amount=Decimal("200"),
            occurred_on=TODAY, actor="pytest",
        )
        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        response = seeded_client.get(
            "/api/v1/quality/exceptions",
            headers={"Authorization": f"Bearer {build_access_token(user)}"},
        )
        assert response.status_code == 200, response.text
        assert all(
            row["entity_id"] != other.order_no
            for row in response.json()["items"]
            if row["entity_type"] == "order"
        )

    def test_quality_endpoint_does_not_leak_cross_pool_transfer(
        self, seeded_client, seeded_db
    ):
        seeded_db.add(
            Cashflow(
                flow_no="TR-HIDDEN-OUT",
                pool_id=2,
                occurred_on=TODAY,
                nature="INTERNAL",
                category="TRANSFER",
                direction="OUT",
                amount=Decimal("100"),
                transfer_id="TR-HIDDEN",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()
        user = CurrentUser.build(
            id=9,
            username="finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )

        response = seeded_client.get(
            "/api/v1/quality/exceptions",
            headers={"Authorization": f"Bearer {build_access_token(user)}"},
        )
        assert response.status_code == 200, response.text
        assert all(row["entity_id"] != "TR-HIDDEN" for row in response.json()["items"])


def test_quality_batch_close_requires_all_issues_open_and_writes_audit(seeded_db):
    first = service.create_issue(
        seeded_db, code="BATCH_CLOSE_A", severity="LOW", title="批量一",
        entity_type="order", entity_id="A", message="待处理", actor="pytest",
    )
    second = service.create_issue(
        seeded_db, code="BATCH_CLOSE_B", severity="LOW", title="批量二",
        entity_type="order", entity_id="B", message="待处理", actor="pytest",
    )
    items = service.batch_close_issues(
        seeded_db, [first.id, second.id], resolution="已批量处理", evidence="批量凭证", actor="pytest"
    )
    assert [item.status for item in items] == ["CLOSED", "CLOSED"]
    assert all(item.resolution == "已批量处理" for item in items)

    from app.core.errors import Conflict
    with pytest.raises(Conflict, match="不可重复关闭"):
        service.batch_close_issues(
            seeded_db, [first.id, second.id], resolution="重复处理", evidence=None, actor="pytest"
        )


def test_quality_batch_close_endpoint(seeded_client, seeded_db):
    first = service.create_issue(
        seeded_db, code="BATCH_API_A", severity="LOW", title="接口批量一",
        entity_type="order", entity_id="API-A", message="待处理", actor="pytest",
    )
    second = service.create_issue(
        seeded_db, code="BATCH_API_B", severity="LOW", title="接口批量二",
        entity_type="order", entity_id="API-B", message="待处理", actor="pytest",
    )
    response = seeded_client.post(
        "/api/v1/quality/issues/batch-close",
        headers={"X-Dev-User": "admin"},
        json={"issue_ids": [first.id, second.id], "resolution": "接口批量已处理"},
    )
    assert response.status_code == 200, response.text
    assert {item["status"] for item in response.json()} == {"CLOSED"}


def test_scan_quality_endpoint_runs_and_returns_list(seeded_client, headers):
    response = seeded_client.post("/api/v1/quality/scan", headers=headers)
    assert response.status_code == 200, response.text
    assert isinstance(response.json(), list)
