"""QLT-01 质量扫描契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.core.security import CurrentUser, build_access_token
from app.domain.trade import Cashflow, OrderEvent, RebateRecord
from app.orders import service as orders_service
from app.quality import service


TODAY = date(2026, 10, 17)


def _order(db, *, order_type="TH", owner_id=None):
    return orders_service.create_order(
        db, order_type=order_type, trade_date=TODAY, actor="pytest", owner_id=owner_id
    )


class TestQualityScan:
    def test_detects_th_unclosed_advance(self, seeded_db):
        order = _order(seeded_db)
        orders_service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
            occurred_on=TODAY, actor="pytest",
        )

        result = service.summary(seeded_db)
        item = next(row for row in result["items"] if row["code"] == "TH_UNCLOSED_ADVANCE")
        assert item["entity_id"] == order.order_no
        assert item["details"]["outstanding"] == "500.00"

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

    def test_detects_unlinked_rebate_without_source_order(self, seeded_db):
        seeded_db.add(
            RebateRecord(
                rebate_no="RB-UNLINKED-1",
                source_order_id=None,
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
        item = next(row for row in issues if row["code"] == "REBATE_UNLINKED")
        assert item["entity_id"] == "RB-UNLINKED-1"

    def test_quality_endpoint_respects_order_scope(self, seeded_client, seeded_db):
        mine = _order(seeded_db, owner_id=9)
        orders_service.post_event(
            seeded_db, mine.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest",
        )
        other = _order(seeded_db, owner_id=8)
        orders_service.post_event(
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
