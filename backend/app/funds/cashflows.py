"""finance 现金流写路径（FIN-04）整合入口：登记、冲销与工作室手工收支编辑。

查询层已拆至 `cashflow_queries.py`（2026-11-18 P2）；会计口径常量归位
`attributes.py`。写操作全部走 Service 事务 + record_audit 三件套。

实现已拆至 `finance/cashflow_writes/`（create / reverse / studio / _shared）；本文件
保留整合出口，并向业务域注册资金流水创建与冲销操作。
"""
from __future__ import annotations

from app.funds.cashflow_writes._shared import _get_cashflow  # 测试契约引用，见 __all__
from app.funds.cashflow_writes.create import create_cashflow
from app.funds.cashflow_writes.reverse import reverse_cashflow
from app.funds.cashflow_writes.studio import delete_cashflow, update_cashflow

# 订单初始成本和分期回款通过协作注册点调用资金流水操作，保持域依赖方向。
# 本模块由 api -> finance_router -> cashflows_router 链路必然加载，注册随之生效。
from app.business.collaboration import register_cashflow_operations  # noqa: E402

register_cashflow_operations(create_cashflow, reverse_cashflow)

__all__ = [
    "_get_cashflow",
    "create_cashflow",
    "delete_cashflow",
    "reverse_cashflow",
    "update_cashflow",
]
