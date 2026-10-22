import pytest

from app.domain.enums import AccountingAttribute, FundNature
from app.finance.attributes import (
    accounting_attribute_for_order_event,
    accounting_attributes_for_manual_cashflow,
    validate_fund_accounting_attribute,
)


@pytest.mark.parametrize(
    ("order_type", "event_type", "expected"),
    [
        ("HS", "BUY", AccountingAttribute.SELF_DIRECT_COST.value),
        ("HS", "SELL", AccountingAttribute.SELF_REVENUE.value),
        ("HS", "PAYMENT", AccountingAttribute.SELF_REVENUE.value),
        ("TH", "BUY", AccountingAttribute.TH_DIRECT_COST.value),
        ("TH", "SELL", AccountingAttribute.TH_REVENUE.value),
        ("DG", "SELL", AccountingAttribute.SERVICE_REVENUE.value),
        ("DFQ", "BUY", AccountingAttribute.DFQ_PRINCIPAL.value),
        ("DFQ", "PAYMENT", AccountingAttribute.DFQ_PRINCIPAL.value),
        ("HS", "CANCEL", AccountingAttribute.REVERSAL.value),
    ],
)
def test_order_event_accounting_attribute_is_business_mapped(
    order_type: str, event_type: str, expected: str
) -> None:
    assert accounting_attribute_for_order_event(order_type, event_type) == (
        FundNature.BUSINESS.value,
        expected,
    )


def test_cashflow_stores_fund_nature_and_accounting_attribute() -> None:
    from datetime import date
    from decimal import Decimal

    from app.domain.trade import Cashflow

    flow = Cashflow(
        flow_no="E2E-ATTR",
        pool_id=1,
        occurred_on=date(2026, 10, 17),
        nature="BUSINESS_OUT",
        direction="OUT",
        amount=Decimal("10.00"),
        fund_nature=FundNature.BUSINESS.value,
        accounting_attribute=AccountingAttribute.TH_DIRECT_COST.value,
    )
    assert flow.fund_nature == FundNature.BUSINESS.value
    assert flow.accounting_attribute == AccountingAttribute.TH_DIRECT_COST.value


@pytest.mark.parametrize(
    ("nature", "category", "direction", "expected"),
    [
        ("EXTERNAL_IN", "OTHER", "IN", ("EXTERNAL", "EXTERNAL_FUNDING")),
        ("BUSINESS_IN", "DEPOSIT_RELEASE", "IN", ("EXTERNAL", "DEPOSIT")),
        ("INTERNAL", "TRANSFER", "IN", ("INTERNAL", "INTERNAL_TRANSFER")),
        ("BUSINESS_OUT", "OFFICE", "OUT", ("BUSINESS", "OPERATING_EXPENSE")),
    ],
)
def test_manual_cashflow_gets_default_fund_and_accounting_attributes(
    nature: str, category: str, direction: str, expected: tuple[str, str]
) -> None:
    assert accounting_attributes_for_manual_cashflow(
        nature=nature, category=category, direction=direction
    ) == expected


@pytest.mark.parametrize(
    ("fund_nature", "attribute"),
    [
        ("BUSINESS", "SELF_REVENUE"),
        ("BUSINESS", "REBATE_INCOME"),
        ("EXTERNAL", "DEPOSIT"),
        ("INTERNAL", "INTERNAL_TRANSFER"),
    ],
)
def test_fund_nature_and_accounting_attribute_valid_combinations(
    fund_nature: str, attribute: str
) -> None:
    assert validate_fund_accounting_attribute(fund_nature, attribute) is None


def test_fund_nature_rejects_cross_layer_attribute() -> None:
    with pytest.raises(ValueError, match="资金性质与核算属性不匹配"):
        validate_fund_accounting_attribute("EXTERNAL", "SELF_REVENUE")


def test_order_event_accounting_attribute_undefined_raises() -> None:
    from app.finance.attributes import accounting_attribute_for_order_event

    with pytest.raises(ValueError, match="未定义订单事件核算属性"):
        accounting_attribute_for_order_event("ZZ", "BUY")
    with pytest.raises(ValueError, match="未定义订单事件核算属性"):
        accounting_attribute_for_order_event("HS", "NOPE")


@pytest.mark.parametrize(
    ("nature", "category", "direction", "expected"),
    [
        ("BUSINESS_IN", "REBATE", "IN", ("BUSINESS", AccountingAttribute.REBATE_INCOME.value)),
        ("BUSINESS_IN", "REBATE_REVERSAL", "IN", ("BUSINESS", AccountingAttribute.REVERSAL.value)),
        ("BUSINESS_IN", "REVERSAL", "IN", ("BUSINESS", AccountingAttribute.REVERSAL.value)),
    ],
)
def test_manual_cashflow_rebate_and_reversal_branches(
    nature: str, category: str, direction: str, expected: tuple[str, str]
) -> None:
    from app.finance.attributes import accounting_attributes_for_manual_cashflow

    assert (
        accounting_attributes_for_manual_cashflow(
            nature=nature, category=category, direction=direction
        )
        == expected
    )


def test_text_required_empty_raises_validation() -> None:
    from app.core.errors import Validation
    from app.finance._common import _text

    with pytest.raises(Validation, match="不能为空"):
        _text("", field="x", message="不能为空")
