"""domain.trade：订单、事件、现金流、账号、分期、押金、返点模型聚合入口。

模型定义按域拆分在 `app.domain.trade_models` 下，本模块只做再导出，
保证 `app.domain.trade` 的导入路径与 `Base.metadata` 注册顺序不变。

不可突破的口径：
- 订单汇总金额、账号成本、分期已收**均由事件派生**，不允许直接写（ORD-02-02）；
- 一个事件最多派生一条有效现金流（FIN-02-03），`DELIVER` 无金额、无现金流；
- 所有金额列 `DECIMAL(18,2)`，禁止 float。
"""
from __future__ import annotations

from .trade_models.account import Account
from .trade_models.cashflow import Cashflow, OrderProfitAllocation, Reconciliation
from .trade_models.deposit_rebate import Deposit, RebateRecord
from .trade_models.form_config import OrderFormField, OrderFormSectionLabel
from .trade_models.installment import (
    Installment,
    InstallmentDisposition,
    InstallmentSchedule,
)
from .trade_models.order import Order, OrderEvent

__all__ = [
    "Account",
    "Cashflow",
    "Deposit",
    "Installment",
    "InstallmentDisposition",
    "InstallmentSchedule",
    "Order",
    "OrderEvent",
    "OrderFormField",
    "OrderFormSectionLabel",
    "OrderProfitAllocation",
    "RebateRecord",
    "Reconciliation",
]
