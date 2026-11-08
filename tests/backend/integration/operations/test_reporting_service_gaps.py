"""REPORT-01 报表边界与导出结果。

只保留能证明当前报表口径、权限或导出契约的行为；不按源码行号追踪覆盖率。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.stocks.profile import create_account
from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import (
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
)
from app.domain.trade import (
    Installment,
    InstallmentDisposition,
)
from app.orders import service as order_service
from app.reporting import service as reporting_service


def _make_bad_debt(seeded_db, *, occurred_on: date) -> int:
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
    return order.id


def test_report_for_export_unsupported_raises(seeded_db):
    with pytest.raises(Validation):
        reporting_service.report_for_export(seeded_db, "bogus")


@pytest.mark.parametrize(
    ("name", "required_keys"),
    [
        ("inventory-health", {"items"}),
        ("monthly-pnl", {"items", "total"}),
        ("commission", {"items", "groups", "total"}),
        ("business-pnl", {"items", "total"}),
        ("daily-funds", {"items", "total"}),
    ],
)
def test_report_for_export_returns_report_shape(seeded_db, name, required_keys):
    result = reporting_service.report_for_export(seeded_db, name)
    assert required_keys <= result.keys()
    assert isinstance(result["items"], list)


def test_report_csv_empty_items_extends_columns():
    csv_text = reporting_service.report_csv({"items": [], "total": None})
    assert csv_text.splitlines()[0] == "\ufeffrow_type,items,total"


# ----------------------------------------------------------- R2 坏账日期过滤
def test_r2_monthly_pnl_bad_debt_date_filters(seeded_db):
    _make_bad_debt(seeded_db, occurred_on=date(2026, 3, 15))
    _make_bad_debt(seeded_db, occurred_on=date(2026, 1, 15))
    _make_bad_debt(seeded_db, occurred_on=date(2026, 7, 15))
    result = reporting_service.r2_monthly_pnl(
        seeded_db, from_date=date(2026, 2, 1), to_date=date(2026, 5, 1)
    )
    assert [item["month"] for item in result["items"]] == ["2026-03"]
    assert result["total"]["account_direct_cost"] == to_money("100")
    assert result["total"]["operating_profit"] == -to_money("100")


# ----------------------------------------------------------- R5 坏账日期过滤
def test_r5_business_pnl_bad_debt_date_filters(seeded_db):
    _make_bad_debt(seeded_db, occurred_on=date(2026, 3, 15))
    _make_bad_debt(seeded_db, occurred_on=date(2026, 1, 15))
    _make_bad_debt(seeded_db, occurred_on=date(2026, 7, 15))
    result = reporting_service.r5_business_pnl(
        seeded_db, from_date=date(2026, 2, 1), to_date=date(2026, 5, 1)
    )
    assert result["total"]["main_cost"] == to_money("100")
    assert result["total"]["main_profit"] == -to_money("100")
