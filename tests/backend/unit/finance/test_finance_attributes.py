"""CASHFLOW-02 资金核算属性与金额边界校验。"""

def test_text_required_empty_raises_validation() -> None:
    from app.core.errors import Validation
    from app.finance._common import _text

    with pytest.raises(Validation, match="不能为空"):
        _text("", field="x", message="不能为空")


def test_non_negative_wraps_money_error_as_validation() -> None:
    """`require_non_negative` 抛 ValueError，边界处必须转成带 field 的 Validation。"""
    from app.core.errors import Validation
    from app.finance._common import _non_negative

    with pytest.raises(Validation) as exc:
        _non_negative("-0.01", field="amount")

    assert exc.value.details["field"] == "amount"
    assert exc.value.details["value"] == "-0.01"


def test_non_negative_returns_decimal_for_valid_input() -> None:
    from decimal import Decimal

    from app.finance._common import _non_negative

    assert _non_negative("12.30", field="amount") == Decimal("12.30")
    assert _non_negative(0, field="amount") == Decimal("0.00")
import pytest
