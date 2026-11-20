"""orders 域的跨域协作注册点（composition root 回调注册表）。

背景（2026-11-18 P0-A）：orders 是最上游域，禁止反向依赖 finance /
installments（backend/.importlinter 契约）。但两处业务行为天然横跨
域边界、且必须与订单写入同事务完成——

1. 订单创建时的「初始成本挂账」：orders/router 内联调用 finance 的
   create_cashflow 写一条支出流水；
2. 非分期 SELL 完成后的「回收处置联动」：orders/events 调用 installments 的
   link_recovered_sale 关联最近一次未转售回收。

解决方案是回调注册：orders 在本模块定义注册点（orders 不 import 任何下游域）；
下游域在**自己模块底部**调用 register_* 完成注册（下游 -> orders 是合法方向）。

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

# 初始成本挂账器：签名与 finance.cashflows.create_cashflow 一致（kwargs 转发）
_cost_flow_creator: Callable[..., Any] | None = None


def register_post_sell_hook(hook: Callable[..., Any]) -> None:
    """注册 SELL 完成联动钩子（由 installments 等下游域调用）。"""
    _post_sell_hooks.append(hook)


def register_cost_flow_creator(creator: Callable[..., Any]) -> None:
    """注册初始成本挂账器（由 finance 域调用，传 finance.cashflows.create_cashflow）。"""
    global _cost_flow_creator
    _cost_flow_creator = creator


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


def create_cost_flow(*args: Any, **kwargs: Any) -> Any:
    """创建订单初始成本流水（转发给 finance 注册的挂账器）。

    未注册即抛错：成本流水是账务写入，静默跳过会造成丢账，必须 fail-fast。
    """
    if _cost_flow_creator is None:
        raise RuntimeError(
            "初始成本挂账器未注册：finance.cashflows 未被加载（注册点 app.business.collaboration）"
        )
    return _cost_flow_creator(*args, **kwargs)


__all__ = [
    "create_cost_flow",
    "register_cost_flow_creator",
    "register_post_sell_hook",
    "run_post_sell_hooks",
]
