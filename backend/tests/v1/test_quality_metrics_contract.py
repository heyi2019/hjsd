"""QLT-01-06 数据质量指标契约测试。"""
from __future__ import annotations

from datetime import date

from app.core.money import to_money
from app.domain.attachments import Attachment
from app.domain.enums import ReconciliationStatus
from app.domain.trade import RebateRecord, Reconciliation
from app.orders import service as order_service


def test_quality_metrics_expose_definitions_and_monthly_trend(
    seeded_client, seeded_db, headers
):
    trade_day = date(2026, 10, 17)
    th_order = order_service.create_order(
        seeded_db, order_type="TH", trade_date=trade_day, actor="pytest"
    )
    order_service.post_event(
        seeded_db,
        th_order.id,
        event_type="BUY",
        amount="100.00",
        occurred_on=trade_day,
        actor="pytest",
    )
    # 一条已关联、一条未关联，验证返点率不是固定常量。
    seeded_db.add_all(
        [
            RebateRecord(
                rebate_no="TH-METRIC-RB01",
                source_order_id=th_order.id,
                rebate_type="BUY",
                rate=to_money("1"),
                base_amount=to_money("100"),
                link_status="LINKED",
                status="OPEN",
                collected_on=trade_day,
                created_by="pytest",
                updated_by="pytest",
            ),
            RebateRecord(
                rebate_no="TH-METRIC-RB02",
                source_order_id=None,
                rebate_type="BUY",
                rate=to_money("1"),
                base_amount=to_money("100"),
                link_status="UNLINKED",
                status="OPEN",
                collected_on=trade_day,
                created_by="pytest",
                updated_by="pytest",
            ),
            Reconciliation(
                pool_id=1,
                reconciled_on=trade_day,
                account_label="测试账户",
                system_balance=to_money("0"),
                statement_balance=to_money("0"),
                difference=to_money("0"),
                status=ReconciliationStatus.RESOLVED.value,
                created_by="pytest",
                updated_by="pytest",
            ),
            Attachment(
                attachment_no="ATT-METRIC-01",
                entity_type="order_event",
                entity_id="not-the-buy-event",
                file_name="placeholder.txt",
                storage_key="placeholder.txt",
                content_type="text/plain",
                size_bytes=1,
                sha256="0" * 64,
                created_by="pytest",
                updated_by="pytest",
            ),
        ]
    )
    seeded_db.flush()

    response = seeded_client.get(
        "/api/v1/quality/metrics",
        params={"from": "2026-10-01", "to": "2026-10-31"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert set(payload["definitions"]) == {
        "linked_rebate_rate",
        "reconciliation_completion_rate",
        "overdue_rate",
        "th_outstanding_amount",
        "missing_attachment_rate",
    }
    assert payload["items"]
    item = payload["items"][0]
    assert item["month"] == "2026-10"
    assert item["linked_rebate_rate"]["numerator"] == 1
    assert item["linked_rebate_rate"]["denominator"] == 2
    assert item["reconciliation_completion_rate"]["rate"] == 100
    assert item["th_outstanding_amount"]["amount"] == "100.00"
    assert item["missing_attachment_rate"]["numerator"] >= 1
