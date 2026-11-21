"""orders 域的跨域协作注册点（composition root 回调注册表）。

业务域不能反向依赖资金域，但以下操作需要在同一事务中协作：

1. 订单初始成本和分期回款的资金流水创建、冲销由资金域执行；
2. 非分期 SELL 完成后的「回收处置联动」：orders/events 调用 installments 的
   link_recovered_sale 关联最近一次未转售回收。

解决方案是回调注册：业务域定义注册点，资金域注册流水操作。

加载链保证注册生效：
- 生产：api import finance_router / installments_router
  -> finance/cashflows.py、installments/create.py 被 import -> 注册执行；
- 测试：tests/backend/conftest.py 模块级 import app.api.create_app，
  收集阶段即完成注册。
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

# SELL 完成后的联动钩子：签名 (session, order, *, occurred_on, actor, note)
_post_sell_hooks: list[Callable[..., Any]] = []

# 资金流水创建和冲销由资金域提供，调用与业务操作处于同一事务。
_cashflow_creator: Callable[..., Any] | None = None
_cashflow_reverser: Callable[..., Any] | None = None


def register_post_sell_hook(hook: Callable[..., Any]) -> None:
    """注册 SELL 完成联动钩子。"""
    _post_sell_hooks.append(hook)


def register_cashflow_operations(creator: Callable[..., Any], reverser: Callable[..., Any]) -> None:
    """由资金域注册流水创建与冲销操作。"""
    global _cashflow_creator, _cashflow_reverser
    _cashflow_creator = creator
    _cashflow_reverser = reverser


def run_post_sell_hooks(
    session: Any,
    order: Any,
    *,
    occurred_on: Any,
    actor: str,
    note: str | None,
) -> None:
    """SELL 完成后依次执行已注册的联动钩子（同一事务内）。"""
    for hook in _post_sell_hooks:
        hook(session, order, occurred_on=occurred_on, actor=actor, note=note)


def create_cashflow(*args: Any, **kwargs: Any) -> Any:
    """创建业务资金流水（转发给资金域）。

    未注册即抛错：成本流水是账务写入，静默跳过会造成丢账，必须 fail-fast。
    """
    if _cashflow_creator is None:
        raise RuntimeError(
            "资金流水创建器未注册：funds.cashflows 未被加载（注册点 app.business.collaboration）"
        )
    return _cashflow_creator(*args, **kwargs)


def reverse_cashflow(*args: Any, **kwargs: Any) -> Any:
    """冲销业务资金流水（转发给资金域）。"""
    if _cashflow_reverser is None:
        raise RuntimeError("资金流水冲销器未注册：funds.cashflows 未被加载（注册点 app.business.collaboration）")
    return _cashflow_reverser(*args, **kwargs)


__all__ = [
    "create_cashflow",
    "reverse_cashflow",
    "register_cashflow_operations",
    "register_post_sell_hook",
    "run_post_sell_hooks",
]
