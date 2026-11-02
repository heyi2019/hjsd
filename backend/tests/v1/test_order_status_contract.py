"""订单 / 账号 / 分期状态机非法流转契约测试（阶段5 高风险）。

状态流转只能通过领域动作，状态机是权限与业务闭环的底座。
这里把合法流转与非法流转（一律 ORDER_STATUS_CONFLICT）钉死，
防止后续改动误开非法状态跳变。纯函数、无 DB、无 HTTP。
"""
from __future__ import annotations

import pytest

from app.core.errors import Validation
from app.core.state_machine import (
    ACCOUNT_TRANSITIONS,
    INSTALLMENT_TRANSITIONS,
    ORDER_TRANSITIONS,
    transition,
)


def test_order_active_to_completed_via_complete():
    assert transition(ORDER_TRANSITIONS, "ACTIVE", "COMPLETE", entity="订单") == "COMPLETED"


def test_order_installment_to_completed_via_complete():
    assert transition(ORDER_TRANSITIONS, "INSTALLMENT", "COMPLETE", entity="订单") == "COMPLETED"


def test_order_completed_buy_reopens_to_active():
    # 已完成的 HS/TH 订单在「无分期」前提下允许再次买入，重开业务周期。
    assert transition(ORDER_TRANSITIONS, "COMPLETED", "BUY", entity="订单") == "ACTIVE"


def test_order_completed_cancel_to_cancelled():
    assert transition(ORDER_TRANSITIONS, "COMPLETED", "CANCEL", entity="订单") == "CANCELLED"


def test_order_cancelled_is_terminal():
    # CANCELLED 无任何后续动作，是个终态。
    with pytest.raises(Validation) as exc:
        transition(ORDER_TRANSITIONS, "CANCELLED", "COMPLETE", entity="订单")
    assert exc.value.code == "ORDER_STATUS_CONFLICT"


def test_order_active_cannot_buy_directly():
    # ACTIVE 状态下不能走 BUY 动作（BUY 仅允许从 COMPLETED 重开业务周期），
    # 非法动作一律 ORDER_STATUS_CONFLICT（与 post_event 的状态校验同源）。
    with pytest.raises(Validation) as exc:
        transition(ORDER_TRANSITIONS, "ACTIVE", "BUY", entity="订单")
    assert exc.value.code == "ORDER_STATUS_CONFLICT"


def test_order_active_can_cancel_to_cancelled():
    # 与上一例对照：ACTIVE 直接 CANCEL 是合法流转（终态 CANCELLED）。
    assert transition(ORDER_TRANSITIONS, "ACTIVE", "CANCEL", entity="订单") == "CANCELLED"


def test_account_transition_illegal_rejected():
    with pytest.raises(Validation) as exc:
        transition(ACCOUNT_TRANSITIONS, "VOID", "SELL", entity="账号")
    assert exc.value.code == "ORDER_STATUS_CONFLICT"


def test_installment_transition_illegal_rejected():
    # SETTLED 之后只能 DELIVER / CANCEL，PAYMENT 非法。
    with pytest.raises(Validation) as exc:
        transition(INSTALLMENT_TRANSITIONS, "SETTLED", "PAYMENT", entity="分期")
    assert exc.value.code == "ORDER_STATUS_CONFLICT"


def test_transition_unknown_current_status_rejected():
    with pytest.raises(Validation) as exc:
        transition(ORDER_TRANSITIONS, "NONEXISTENT", "COMPLETE", entity="订单")
    assert exc.value.code == "ORDER_STATUS_CONFLICT"
