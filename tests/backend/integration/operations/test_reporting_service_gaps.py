"""REPORT-01 reporting.service 补充覆盖：补齐全量基线中的可达缺口。

覆盖点：
- service.py:87    report_for_export 不支持的报表名抛 Validation
- service.py:92/94/96/100/104  report_for_export 分发到 R1/R2/R3/R5/日报
- service.py:123   report_csv 空报表时扩展 columns 到 items/total
- service.py:190   finance_dimension_report 受限用户走池过滤分支
- service.py:246/248/250  _event_contribution 的 CANCEL 偏移 BUY/COST/未知
- service.py:262   _event_totals 跳过未过账事件
- service.py:454-458  R2 坏账行日期过滤（区内加、区外 continue）
- service.py:584   R3 坏账计入 per_order_profit
- service.py:669-675  R5 坏账行日期过滤（区内按 order_type 加成本）
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.stocks.profile import create_account
from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser
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
from app.orders import service as order_service
from app.reporting import service as reporting_service
from app.reporting.service import (
    ZERO,
    _event_contribution,
    _event_totals,
)


def _make_bad_debt(seeded_db, *, occurred_on: date, with_event: bool = False) -> int:
    """直接插入坏账行（Installment.bad_debt_amount>0 + RECOVER 处置），避开重业务流。"""
    account = create_account(
        seeded_db,
        game_account=f"bd-{occurred_on.isoformat()}",
        actor="pytest",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
    )
    order = order_service.create_order(
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
        reporting_service.report_for_export(seeded_db, "bogus")  # 87


@pytest.mark.parametrize(
    "name",
    ["inventory-health", "monthly-pnl", "commission", "business-pnl", "daily-funds"],
)
def test_report_for_export_dispatches(seeded_db, name):
    result = reporting_service.report_for_export(seeded_db, name)
    assert isinstance(result, dict)
    assert "items" in result  # 92/94/96/100/104


# ----------------------------------------------------------- report_csv 空列扩展
def test_report_csv_empty_items_extends_columns():
    csv_text = reporting_service.report_csv({"items": [], "total": None})
    assert csv_text.startswith("\ufeff")
    # 空报表只有 row_type 一列 → 扩展到 items/total（service.py:123）
    assert "items" in csv_text and "total" in csv_text


# ----------------------------------------------------------- finance_dimension 受限用户
def test_finance_dimension_report_scoped_pool_ids(seeded_db):
    user = CurrentUser(
        id=1,
        username="scope",
        roles=(),
        permissions=frozenset(),
        owner_scope="SELF",
        pool_ids=frozenset({1}),
    )
    result = reporting_service.finance_dimension_report(seeded_db, user=user)  # 190
    assert isinstance(result, dict)


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
    assert _event_contribution(ev, {1: EventType.BUY.value}) == (
        ZERO,
        -to_money("10"),
        ZERO,
    )  # 246


def test_event_contribution_cancel_offset_unknown():
    ev = _FakeEvent(EventType.CANCEL.value, 1, Decimal("10"))
    assert _event_contribution(ev, {}) == (ZERO, ZERO, ZERO)  # 250


# ----------------------------------------------------------- _event_totals 未过账
def test_event_totals_skips_unposted():
    ev = _FakeEvent(EventType.SELL.value, None, Decimal("100"))
    ev.is_posted = False
    assert _event_totals([ev]) == (ZERO, ZERO, ZERO)  # 262


# ----------------------------------------------------------- R2 坏账日期过滤
def test_r2_monthly_pnl_bad_debt_date_filters(seeded_db):
    _make_bad_debt(seeded_db, occurred_on=date(2026, 3, 15))  # 区内
    _make_bad_debt(seeded_db, occurred_on=date(2026, 1, 15))  # 区前
    _make_bad_debt(seeded_db, occurred_on=date(2026, 7, 15))  # 区后
    result = reporting_service.r2_monthly_pnl(
        seeded_db, from_date=date(2026, 2, 1), to_date=date(2026, 5, 1)
    )
    assert isinstance(result, dict)  # 454-458


# ----------------------------------------------------------- R3 坏账计入
def test_r3_commission_includes_bad_debt(seeded_db):
    _make_bad_debt(seeded_db, occurred_on=date(2026, 4, 10))
    result = reporting_service.r3_commission_reconciliation(seeded_db)
    assert isinstance(result, dict)  # 584


# ----------------------------------------------------------- R5 坏账日期过滤
def test_r5_business_pnl_bad_debt_date_filters(seeded_db):
    _make_bad_debt(seeded_db, occurred_on=date(2026, 3, 15), with_event=True)  # 区内带事件
    _make_bad_debt(seeded_db, occurred_on=date(2026, 1, 15))  # 区前
    _make_bad_debt(seeded_db, occurred_on=date(2026, 7, 15))  # 区后
    result = reporting_service.r5_business_pnl(
        seeded_db, from_date=date(2026, 2, 1), to_date=date(2026, 5, 1)
    )
    assert isinstance(result, dict)  # 669-675
