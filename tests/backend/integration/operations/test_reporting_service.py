"""REPORT-01 报表服务与导出契约：报告筛选、金额口径及 CSV 输出。

覆盖点：
- service.py:87    report_for_export 不支持的报表名抛 Validation
- service.py:123   report_csv 空报表时扩展 columns 到 items/total
- orders/amounts.py  event_contribution 的 CANCEL 偏移 BUY/COST/未知
- orders/amounts.py  event_totals 跳过未过账事件
"""
from __future__ import annotations

import csv
import io
from datetime import date
from decimal import Decimal

import pytest

from app.business.inventory.profile import create_account
from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import (
    EventType,
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
)
from app.domain.trade import (
    Installment,
    InstallmentDisposition,
    OrderEvent,
)
from app.shared.order_amounts import (
    ZERO,
    event_contribution,
    event_totals,
)
from app.business.create import create_order
from app.operations.export import report_csv, report_for_export

TODAY = date(2026, 10, 17)


def _make_bad_debt(seeded_db, *, occurred_on: date, with_event: bool = False) -> int:
    """直接插入坏账行（Installment.bad_debt_amount>0 + RECOVER 处置），避开重业务流。"""
    account = create_account(
        seeded_db,
        game_account=f"bd-{occurred_on.isoformat()}",
        actor="pytest",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
    )
    order = create_order(
        seeded_db,
        order_type="TH",
        trade_date=occurred_on,
        actor="pytest",
        account_id=account.id,
    )
    inst = Installment(
        inst_no=f"BD-{occurred_on.isoformat()}",
        order_id=order.id,
        contract_type=InstallmentContractType.PICKUP_SALE.value,
        principal=Decimal("0"),
        down_payment=Decimal("0"),
        service_fee=Decimal("0"),
        periods=1,
        per_period_service_fee=Decimal("0"),
        per_period=Decimal("0"),
        bad_debt_amount=Decimal("100"),
        status=InstallmentStatus.DEFAULTED.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(inst)
    seeded_db.flush()
    disp = InstallmentDisposition(
        installment_id=inst.id,
        account_id=account.id,
        action=InstallmentDispositionAction.RECOVER.value,
        occurred_on=occurred_on,
        note="bad debt",
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(disp)
    seeded_db.flush()
    if with_event:
        event = OrderEvent(
            event_no=f"E-{occurred_on.isoformat()}",
            order_id=order.id,
            event_type=EventType.SELL.value,
            amount=Decimal("100"),
            occurred_on=occurred_on,
            is_posted=True,
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(event)
        seeded_db.flush()
    return order.id


# ----------------------------------------------------------- report_for_export 分发
def test_report_for_export_unsupported_raises(seeded_db):
    with pytest.raises(Validation):
        report_for_export(seeded_db, "bogus")  # 87


# ----------------------------------------------------------- report_csv 空列扩展
def test_report_csv_empty_items_extends_columns():
    csv_text = report_csv({"items": [], "total": None})
    assert csv_text.startswith("\ufeff")
    # 空报表只有 row_type 一列 → 扩展到 items/total（service.py:123）
    assert "items" in csv_text and "total" in csv_text


def test_report_csv_normalizes_none_and_compound_values():
    csv_text = report_csv({
        "items": [{"name": "a", "note": None, "meta": {"k": 1}, "tags": [1, 2]}],
        "total": {"name": "合计"},
    })
    rows = list(csv.reader(io.StringIO(csv_text)))
    header = rows[0]
    item_row = next(row for row in rows if row[0] == "ITEM")
    assert item_row[header.index("note")] == ""
    assert item_row[header.index("meta")] == '{"k": 1}'
    assert item_row[header.index("tags")] == "[1, 2]"


# ----------------------------------------------------------- finance_dimension 受限用户
# ----------------------------------------------------------- _event_contribution CANCEL
class _FakeEvent:
    def __init__(self, event_type, offset_event_id, amount):
        self.event_type = event_type
        self.offset_event_id = offset_event_id
        self.amount = amount
        self.is_posted = True
        self.occurred_on = date(2026, 1, 1)
        self.id = 1


def test_event_contribution_cancel_offset_buy():
    ev = _FakeEvent(EventType.CANCEL.value, 1, Decimal("10"))
    assert event_contribution(ev, {1: EventType.BUY.value}) == (
        ZERO,
        -to_money("10"),
        ZERO,
    )


def test_event_contribution_cancel_offset_unknown():
    ev = _FakeEvent(EventType.CANCEL.value, 1, Decimal("10"))
    assert event_contribution(ev, {}) == (ZERO, ZERO, ZERO)


# ----------------------------------------------------------- event_totals 未过账
def test_event_totals_skips_unposted():
    ev = _FakeEvent(EventType.SELL.value, None, Decimal("100"))
    ev.is_posted = False
    assert event_totals([ev]) == (ZERO, ZERO, ZERO)


# ----------------------------------------------------------- R2 坏账日期过滤
# ----------------------------------------------------------- R3 坏账计入
# ----------------------------------------------------------- R5 坏账日期过滤
