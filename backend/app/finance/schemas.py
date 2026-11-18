"""finance.schemas：押金与返点的请求/响应模型。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.core.money import to_money
from app.core.schemas import RequestModel
from app.domain.enums import CashflowLedgerType


class DepositCreate(RequestModel):
    pool_id: int
    amount: Decimal
    paid_on: date
    ledger_type: str = CashflowLedgerType.BUSINESS.value
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    counterparty_id: int | None = None
    source_order_id: int | None = None
    expected_release_on: date | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None


class DepositUpdate(DepositCreate):
    """未发生释放/损失的押金允许整体修正，保持占用流水同步。"""



class DepositReturn(RequestModel):
    amount: Decimal
    released_on: date
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    form_extra: dict[str, Any] | None = None


class DepositLoss(RequestModel):
    amount: Decimal
    lost_on: date
    category: str
    reason: str
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    form_extra: dict[str, Any] | None = None


class DepositCancel(RequestModel):
    cancelled_on: date
    reason: str = Field(min_length=1, max_length=2000)
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    form_extra: dict[str, Any] | None = None


class DepositOperationOperatorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    operation_key: str
    operator_user_ids: list[int]
    occurred_at: datetime


class DepositOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    pool_id: int
    ledger_type: str
    counterparty_id: int | None = None
    source_order_id: int | None = None
    paid_amount: Decimal
    returned_amount: Decimal
    lost_amount: Decimal
    status: str
    paid_on: date
    expected_release_on: date | None = None
    released_on: date | None = None
    lost_on: date | None = None
    note: str | None = None
    created_at: datetime
    operator: str
    form_extra: dict[str, Any] | None = None
    operation_operators: list[DepositOperationOperatorOut] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def remaining_amount(self) -> Decimal:
        """押金剩余 = 实收 − 已退 − 已损失，且不小于 0。

        前端原先在资金页表格与移动端卡片各写一遍这个减法，口径与夹底改由后端给。
        """
        remaining = (
            to_money(self.paid_amount)
            - to_money(self.returned_amount)
            - to_money(self.lost_amount)
        )
        return remaining if remaining > 0 else Decimal("0.00")


class CashflowOut(BaseModel):
    id: int
    flow_no: str
    pool_id: int
    occurred_on: date
    occurred_at: datetime
    ledger_type: str
    accounting_attribute: str
    category: str
    direction: str
    amount: Decimal
    source_type: str
    source_id: str | None = None
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    order_id: int | None = None
    order_no: str | None = None
    source: str
    note: str | None = None
    form_extra: dict[str, Any] | None = None
    operator: str
    operator_user_ids: list[int] | None = None
    extra_values: dict[str, Any] = Field(default_factory=dict)


class StudioSummaryOut(BaseModel):
    """工作室收支面板：明细与即时入账汇总一次取回。"""

    items: list[CashflowOut]
    income: Decimal = Decimal("0")
    expense: Decimal = Decimal("0")
    net: Decimal = Decimal("0")
    count: int = Field(ge=0)


class CashflowListOut(BaseModel):
    """资金流水分页响应：返回本页明细与命中总数，便于前端判断是否还有更多。

    `total_in` / `total_out` 是按**同一套筛选条件**在服务端聚合的合计，不受 `limit`
    影响——前端不再对当页求和，流水超过上限也不会静默少算。
    """

    items: list[CashflowOut]
    total: int = Field(ge=0)
    total_in: Decimal = Decimal("0")
    total_out: Decimal = Decimal("0")


class CashflowTotalsOut(BaseModel):
    total_in: Decimal = Decimal("0")
    total_out: Decimal = Decimal("0")


class CashflowCreate(RequestModel):
    pool_id: int
    occurred_on: date
    direction: str
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    ledger_type: str = CashflowLedgerType.BUSINESS.value
    accounting_attribute: str | None = None
    category: str
    amount: Decimal
    order_id: int | None = None
    note: str | None = None
    extra_values: dict[str, Any] | None = None
    # 表单字段配置体系（STUDIOEXP 作用域）：自定义字段值落 Cashflow.form_extra。
    form_extra: dict[str, Any] | None = None
    form_extra_scope: str = "FUNDFLOW"


class CashflowUpdate(RequestModel):
    """工作室手工收支直接编辑，不进入审批态。"""

    pool_id: int
    occurred_on: date
    direction: str
    accounting_attribute: str | None = None
    category: str
    amount: Decimal
    note: str | None = None
    form_extra: dict[str, Any] | None = None
    form_extra_scope: str = "STUDIOEXP"


class CashflowReverse(RequestModel):
    reversed_on: date
    reason: str
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    # 表单字段配置体系（STUDIOREV 作用域）：落冲销流水 form_extra。
    form_extra: dict[str, Any] | None = None
    form_extra_scope: str = "FUNDREVERSE"


class ReconciliationCreate(RequestModel):
    pool_id: int
    reconciled_on: date
    account_label: str
    statement_balance: Decimal
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    unmatched_flow_ids: list[int] = Field(default_factory=list)
    reason: str | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None


class ReconciliationResolve(RequestModel):
    reason: str
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    form_extra: dict[str, Any] | None = None


class ReconciliationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    pool_id: int
    reconciled_on: date
    account_label: str
    system_balance: Decimal
    statement_balance: Decimal
    difference: Decimal
    status: str
    reason: str | None = None
    unmatched_flow_ids: list[int]
    resolved_by: str | None = None
    resolved_at: datetime | None = None
    note: str | None = None
    created_at: datetime
    operator: str
    form_extra: dict[str, Any] | None = None
    operation_operators: list[DepositOperationOperatorOut] = Field(default_factory=list)


class TransferCreate(RequestModel):
    source_pool_id: int
    target_pool_id: int
    amount: Decimal
    occurred_on: date
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    note: str | None = None
    form_extra: dict[str, Any] | None = None


class TransferRepair(RequestModel):
    counterpart_pool_id: int
    reason: str
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    form_extra: dict[str, Any] | None = None


class TransferOut(BaseModel):
    transfer_id: str
    source_pool_id: int
    target_pool_id: int
    amount: Decimal
    occurred_on: date
    created_at: datetime
    operator: str
    cashflows: list[CashflowOut]
    operation_operators: list[DepositOperationOperatorOut] = Field(default_factory=list)


class RebateCreate(RequestModel):
    source_order_id: int
    rebate_type: str = Field(description="BUY 买号返点 / SELL 卖号返点")
    amount: Decimal
    collected_on: date
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    channel: str | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None


class RebateUpdate(RequestModel):
    amount: Decimal | None = None
    collected_on: date | None = None
    note: str | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    form_extra: dict[str, Any] | None = None


class RebateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rebate_no: str
    source_order_id: int
    rebate_type: str
    channel: str | None = None
    amount: Decimal
    collected_on: date
    note: str | None = None
    created_at: datetime
    operator: str
    operator_user_ids: list[int] | None = None
    form_extra: dict[str, Any] | None = None
class PoolBalanceOut(BaseModel):
    pool_id: int
    pool_code: str
    income: Decimal
    expense: Decimal
    transfer_in: Decimal
    transfer_out: Decimal
    cash_balance: Decimal
    deposit_held: Decimal
    available: Decimal


class PoolBalanceTotalsOut(BaseModel):
    """资金账户余额汇总：服务端按 Decimal 聚合，前端只展示不再自己累加。"""

    pool_count: int
    cash_balance: Decimal
    # 可用余额 = 现金余额；押金占用已在 expense 扣过一次，不再二次减 deposit_held。
    available: Decimal
    deposit_held: Decimal  # 其中项：押金占用，仅展示不参与 available 计算


class PoolBalanceListOut(BaseModel):
    """批量余额：一次返回全部可见池的卡片与汇总，替代前端逐池 N+1。"""

    items: list[PoolBalanceOut]
    totals: PoolBalanceTotalsOut


__all__ = [
    "DepositCreate",
    "DepositOperationOperatorOut",
    "DepositOut",
    "DepositReturn",
    "DepositLoss",
    "CashflowOut",
    "CashflowListOut",
    "StudioSummaryOut",
    "CashflowCreate",
    "CashflowUpdate",
    "CashflowReverse",
    "ReconciliationCreate",
    "ReconciliationResolve",
    "ReconciliationOut",
    "TransferCreate",
    "TransferRepair",
    "TransferOut",
    "RebateCreate",
    "RebateOut",
    "PoolBalanceOut",
    "PoolBalanceTotalsOut",
    "PoolBalanceListOut",
]
