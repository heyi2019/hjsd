"""MONEY-01 T01 / SYS-01-01：金额精度 —— Decimal / DECIMAL(18,2)，禁止 float。"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.money import (
    Amount,
    PRECISION,
    SCALE,
    money_equal,
    require_non_negative,
    require_positive,
    sum_amounts,
    to_money,
)


def test_to_money_quantizes_half_up():
    assert to_money("1234.565") == Decimal("1234.57")
    assert to_money(1234.564) == Decimal("1234.56")
    assert to_money(0) == Decimal("0.00")
    assert to_money("0.005") == Decimal("0.01")


def test_float_addition_does_not_leak_error():
    """业务层用 Decimal，避免 0.1 + 0.2 != 0.3 的浮点尾差。"""
    left = Decimal("0.1")
    right = Decimal("0.2")
    assert left + right == Decimal("0.30")
    assert to_money(left + right) == Decimal("0.30")
    assert 0.1 + 0.2 != 0.3  # 反例对照：float 确实不可用于金额


@pytest.mark.parametrize("bad", [None, True, "abc", float("nan"), float("inf"), "12,34.5"])
def test_invalid_amounts_rejected(bad):
    with pytest.raises(ValueError):
        to_money(bad)


def test_require_positive_and_non_negative():
    with pytest.raises(ValueError):
        require_positive("0.00")
    with pytest.raises(ValueError):
        require_positive("-1.00")
    assert require_positive("0.01") == Decimal("0.01")
    with pytest.raises(ValueError):
        require_non_negative("-0.01")
    assert require_non_negative("0.00") == Decimal("0.00")


def test_sum_amounts_empty_is_zero():
    assert sum_amounts([]) == Decimal("0.00")
    assert sum_amounts(["1.10", Decimal("2.20"), 3]) == Decimal("6.30")


def test_money_equal_tolerance():
    assert money_equal(Decimal("100.00"), Decimal("100.00"))
    assert not money_equal(Decimal("100.00"), Decimal("100.02"))


def test_amount_column_roundtrip_is_lossless_at_business_scale():
    """DECIMAL(18,2) 列类型往返：9,999,999,999.99 级别必须无损（bind→result 等价 DB 往返）。"""
    amt = Amount()
    samples = [
        Decimal("0.01"),
        Decimal("1234.56"),
        Decimal("99999999.99"),
        Decimal("9999999999.99"),
    ]
    out = [amt.process_result_value(amt.process_bind_param(s, None), None) for s in samples]
    assert out == samples
    assert all(isinstance(value, Decimal) for value in out)


def test_amount_column_precision_constants():
    assert (PRECISION, SCALE) == (18, 2)
