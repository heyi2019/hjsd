"""CASHFLOW-02 流水方向与类别到核算属性的映射。"""

import pytest

from app.domain.cashflow_attributes import accounting_attribute_for_order_event
from app.domain.enums import AccountingAttribute
from app.funds.attributes import accounting_attribute_for_manual_cashflow


@pytest.mark.parametrize(
    ("order_type", "event_type", "expected"),
    [
        ("HS", "BUY", AccountingAttribute.SELF_DIRECT_COST.value),
        ("HS", "SELL", AccountingAttribute.SELF_REVENUE.value),
        ("TH", "BUY", AccountingAttribute.TH_DIRECT_COST.value),
        ("TH", "SELL", AccountingAttribute.TH_REVENUE.value),
        ("DG", "SELL", AccountingAttribute.DG_REVENUE.value),
        ("HS", "CANCEL", AccountingAttribute.REVERSAL.value),
    ],
)
def test_order_event_accounting_attribute_is_business_mapped(
    order_type: str, event_type: str, expected: str
) -> None:
    assert accounting_attribute_for_order_event(order_type, event_type) == expected


def test_cashflow_stores_accounting_attribute() -> None:
    from datetime import date
    from decimal import Decimal

    from app.domain.trade import Cashflow

    flow = Cashflow(
        flow_no="E2E-ATTR",
        pool_id=1,
        occurred_on=date(2026, 10, 17),
        direction="OUT",
        amount=Decimal("10.00"),
        accounting_attribute=AccountingAttribute.TH_DIRECT_COST.value,
    )
    assert flow.accounting_attribute == AccountingAttribute.TH_DIRECT_COST.value


@pytest.mark.parametrize(
    ("category", "direction", "expected"),
    [
        ("DEPOSIT_RELEASE", "IN", "DEPOSIT"),
        ("TRANSFER", "IN", "INTERNAL_TRANSFER"),
        ("OFFICE", "OUT", "OPERATING_EXPENSE"),
    ],
)
def test_manual_cashflow_gets_default_accounting_attribute(
    category: str, direction: str, expected: str
) -> None:
    assert accounting_attribute_for_manual_cashflow(
        category=category, direction=direction
    ) == expected


def test_order_event_accounting_attribute_undefined_raises() -> None:
    from app.domain.cashflow_attributes import accounting_attribute_for_order_event

    with pytest.raises(ValueError, match="未定义订单事件核算属性"):
        accounting_attribute_for_order_event("ZZ", "BUY")
    with pytest.raises(ValueError, match="未定义订单事件核算属性"):
        accounting_attribute_for_order_event("HS", "NOPE")


@pytest.mark.parametrize(
    ("category", "direction", "expected"),
    [
        ("REBATE", "IN", AccountingAttribute.REBATE_INCOME.value),
        ("REVERSAL", "IN", AccountingAttribute.REVERSAL.value),
    ],
)
def test_manual_cashflow_rebate_and_reversal_branches(
    category: str, direction: str, expected: str
) -> None:
    assert (
        accounting_attribute_for_manual_cashflow(
            category=category, direction=direction
        )
        == expected
    )


def test_text_required_empty_raises_validation() -> None:
    from app.core.errors import Validation
    from app.funds._common import _text

    with pytest.raises(Validation, match="不能为空"):
        _text("", field="x", message="不能为空")


def test_non_negative_wraps_money_error_as_validation() -> None:
    """`require_non_negative` 抛 ValueError，边界处必须转成带 field 的 Validation。"""
    from app.core.errors import Validation
    from app.funds._common import _non_negative

    with pytest.raises(Validation) as exc:
        _non_negative("-0.01", field="amount")

    assert exc.value.details["field"] == "amount"
    assert exc.value.details["value"] == "-0.01"


def test_non_negative_returns_decimal_for_valid_input() -> None:
    from decimal import Decimal

    from app.funds._common import _non_negative

    assert _non_negative("12.30", field="amount") == Decimal("12.30")
    assert _non_negative(0, field="amount") == Decimal("0.00")
