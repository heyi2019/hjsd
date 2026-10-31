"""ERP 核心状态机的集中定义与校验。

状态只能通过领域动作流转；本模块不直接修改 ORM 对象，供 Service 层在事务内
校验动作是否合法，并让测试可以独立覆盖全部合法/非法边界。
"""
from __future__ import annotations

from collections.abc import Mapping

from app.core.errors import ErrorCode, Validation


ORDER_TRANSITIONS: Mapping[str, Mapping[str, str]] = {
    "ACTIVE": {"INSTALLMENT": "INSTALLMENT", "COMPLETE": "COMPLETED", "CANCEL": "CANCELLED"},
    # 完成后的 SELL 仍可通过带 offset_event_id 的 CANCEL 冲销，
    # 以支持售出撤销并恢复库存；完整冲销后订单进入 CANCELLED。
    "COMPLETED": {
        "BUY": "ACTIVE",
        "CANCEL": "CANCELLED",
    },
    "INSTALLMENT": {
        "COMPLETE": "COMPLETED",
        "CANCEL": "CANCELLED",
    },
    "CANCELLED": {},
}

ACCOUNT_TRANSITIONS: Mapping[str, Mapping[str, str]] = {
    # 同一账号允许再次买入，作为重新入库事件保留历史轨迹。
    "IN_STOCK": {"BUY_STOCK": "IN_STOCK", "BUY_CREDIT": "SOLD", "SELL": "SOLD", "VOID": "VOID"},
    "SOLD": {
        "BUY_STOCK": "IN_STOCK",
        "BUY_CREDIT": "SOLD",
        "RECOVER": "IN_STOCK",
        "CANCEL_STOCK": "IN_STOCK",
        "CANCEL_SELL": "IN_STOCK",
        "CANCEL_SELL_END": "VOID",
        "VOID": "VOID",
    },
    "VOID": {},
}

INSTALLMENT_TRANSITIONS: Mapping[str, Mapping[str, str]] = {
    "PENDING": {
        "PAYMENT": "ACTIVE",
        "MARK_OVERDUE": "OVERDUE",
        "SETTLE": "SETTLED",
        "CANCEL": "CANCELLED",
    },
    "ACTIVE": {"PAYMENT": "ACTIVE", "MARK_OVERDUE": "OVERDUE", "SETTLE": "SETTLED", "DEFAULT": "DEFAULTED", "CANCEL": "CANCELLED"},
    "OVERDUE": {
        "PAYMENT": "OVERDUE",
        "SETTLE": "SETTLED",
        "DEFAULT": "DEFAULTED",
        "CLOSE": "CLOSED",
        "CANCEL": "CANCELLED",
    },
    "SETTLED": {"DELIVER": "DELIVERED", "CANCEL": "CANCELLED"},
    "DELIVERED": {},
    "DEFAULTED": {"PAYMENT": "DEFAULTED", "CLOSE": "CLOSED"},
    "CLOSED": {},
    "CANCELLED": {},
}


def transition(
    machine: Mapping[str, Mapping[str, str]],
    current: str,
    action: str,
    *,
    entity: str,
) -> str:
    """返回动作后的状态；非法动作统一返回业务校验错误。"""
    next_status = machine.get(current, {}).get(action)
    if next_status is None:
        raise Validation(
            f"{entity} 当前状态 {current} 不允许执行 {action}",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"entity": entity, "current_status": current, "action": action},
        )
    return next_status


__all__ = [
    "ACCOUNT_TRANSITIONS",
    "INSTALLMENT_TRANSITIONS",
    "ORDER_TRANSITIONS",
    "transition",
]
