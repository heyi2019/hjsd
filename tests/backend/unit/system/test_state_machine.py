"""STATE-01 非法状态流转必须拒绝，不得静默落库。"""

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
    assert transition(ORDER_TRANSITIONS, "ACTIVE", "INSTALLMENT", entity="订单") == "INSTALLMENT"
    assert transition(ORDER_TRANSITIONS, "ACTIVE", "CANCEL", entity="订单") == "CANCELLED"
    with pytest.raises(Validation) as exc:
        transition(ORDER_TRANSITIONS, "COMPLETED", "PAYMENT", entity="订单")
    assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT


def test_account_paths_keep_account_cycle_separate_from_installment():
    assert transition(ACCOUNT_TRANSITIONS, "WAITING", "BUY_STOCK", entity="账号") == "WAITING"
    assert transition(ACCOUNT_TRANSITIONS, "SOLD", "BUY_STOCK", entity="账号") == "WAITING"
    assert transition(ACCOUNT_TRANSITIONS, "SOLD", "RECOVER", entity="账号") == "WAITING"
    with pytest.raises(Validation):
        transition(ACCOUNT_TRANSITIONS, "WAITING", "BUY_CREDIT", entity="账号")
    with pytest.raises(Validation):
        transition(ACCOUNT_TRANSITIONS, "SOLD", "SELL", entity="账号")


def test_installment_delivery_requires_settlement():
    assert transition(INSTALLMENT_TRANSITIONS, "PENDING", "INSTALLMENT_PAYMENT", entity="分期合约") == "ACTIVE"
    with pytest.raises(Validation):
        transition(INSTALLMENT_TRANSITIONS, "PENDING", "PAYMENT", entity="分期合约")
    assert transition(INSTALLMENT_TRANSITIONS, "SETTLED", "DELIVER", entity="分期合约") == "DELIVERED"
    with pytest.raises(Validation):
        transition(INSTALLMENT_TRANSITIONS, "ACTIVE", "DELIVER", entity="分期合约")
