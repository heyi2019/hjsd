from __future__ import annotations

import pytest

from app.core.errors import ErrorCode, Validation
from app.core.state_machine import (
    ACCOUNT_TRANSITIONS,
    INSTALLMENT_TRANSITIONS,
    ORDER_TRANSITIONS,
    transition,
)


def test_order_has_only_active_exit_paths():
    assert transition(ORDER_TRANSITIONS, "ACTIVE", "COMPLETE", entity="订单") == "COMPLETED"
    assert transition(ORDER_TRANSITIONS, "ACTIVE", "CANCEL", entity="订单") == "CANCELLED"
    with pytest.raises(Validation) as exc:
        transition(ORDER_TRANSITIONS, "COMPLETED", "PAYMENT", entity="订单")
    assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT


def test_account_paths_keep_installment_and_stock_distinct():
    assert transition(ACCOUNT_TRANSITIONS, "IN_STOCK", "BUY_STOCK", entity="账号") == "IN_STOCK"
    assert transition(ACCOUNT_TRANSITIONS, "IN_STOCK", "BUY_CREDIT", entity="账号") == "INSTALLMENT"
    assert transition(ACCOUNT_TRANSITIONS, "INSTALLMENT", "DELIVER", entity="账号") == "SOLD"
    with pytest.raises(Validation):
        transition(ACCOUNT_TRANSITIONS, "SOLD", "SELL", entity="账号")


def test_installment_delivery_requires_settlement():
    assert transition(INSTALLMENT_TRANSITIONS, "SETTLED", "DELIVER", entity="分期合约") == "DELIVERED"
    with pytest.raises(Validation):
        transition(INSTALLMENT_TRANSITIONS, "ACTIVE", "DELIVER", entity="分期合约")
