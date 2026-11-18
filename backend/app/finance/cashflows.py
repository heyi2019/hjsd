"""finance 现金流写路径（FIN-04）整合入口：登记、冲销与工作室手工收支编辑。

查询层已拆至 `cashflow_queries.py`（2026-11-18 P2）；会计口径常量归位
`attributes.py`。写操作全部走 Service 事务 + record_audit 三件套。

实现已拆至 `finance/cashflow_writes/`（create / reverse / studio / _shared）；本文件
保留整合出口与初始成本挂账注册点，调用方无需改动。
"""
from __future__ import annotations

from app.finance.cashflow_writes._shared import _get_cashflow  # noqa: F401（测试契约引用）
from app.finance.cashflow_writes.create import create_cashflow
from app.finance.cashflow_writes.reverse import reverse_cashflow
from app.finance.cashflow_writes.studio import delete_cashflow, update_cashflow

# P0-A（2026-11-18）：orders 创建订单时的初始成本挂账经协作注册点注入，
# 消灭 orders -> finance 反向依赖（backend/.importlinter 契约）。
# 本模块由 api_v1 -> finance_router -> cashflows_router 链路必然加载，注册随之生效。
from app.orders.collaboration import register_cost_flow_creator  # noqa: E402

register_cost_flow_creator(create_cashflow)

__all__ = [
    "create_cashflow",
    "delete_cashflow",
    "reverse_cashflow",
    "update_cashflow",
]
