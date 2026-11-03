"""ORDER-01 orders 领域共用校验覆盖（补充 _common 未覆盖分支）。"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.errors import Validation
from app.orders._common import _non_negative_money


def test_non_negative_money_rejects_negative_value():
    with pytest.raises(Validation):
        _non_negative_money(Decimal("-1"), field="amount")


def test_non_negative_money_rejects_non_numeric_string():
    with pytest.raises(Validation):
        _non_negative_money("not-a-number", field="amount")
