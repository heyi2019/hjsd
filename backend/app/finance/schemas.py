"""finance.schemas：押金与返点的请求/响应模型。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.core.money import to_money
from app.core.schemas import RequestModel


class DepositCreate(RequestModel):
    pool_id: int
    amount: Decimal
    paid_on: date
    counterparty_id: int | None = None
    source_order_id: int | None = None
    expected_release_on: date | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None



class DepositReturn(RequestModel):
    amount: Decimal
    released_on: date
    form_extra: dict[str, Any] | None = None


class DepositLoss(RequestModel):
    amount: Decimal
    lost_on: date
    category: str
    reason: str
    form_extra: dict[str, Any] | None = None


class DepositCancel(RequestModel):
    cancelled_on: date
    reason: str = Field(min_length=1, max_length=2000)
    form_extra: dict[str, Any] | None = None


class DepositOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    pool_id: int
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
    nature: str
    fund_nature: str
    accounting_attribute: str
    category: str
    direction: str
    amount: Decimal
    status: str
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    reversal_of_id: int | None = None
    order_id: int | None = None
    order_no: str | None = None
    deposit_id: int | None = None
    order_event_id: int | None = None
    transfer_id: str | None = None
    source: str
    note: str | None = None
    form_extra: dict[str, Any] | None = None
    operator: str
    extra_values: dict[str, Any] = Field(default_factory=dict)


class StudioSummaryOut(BaseModel):
    """工作室收支面板：明细 + 已入账汇总，一次取回。

    汇总只统计 APPROVED（待审核/已驳回不进经营口径），且不受 items 的 `limit` 影响。
    ``approved_net`` = approved_income − approved_expense，由后端算，前端不再相减。
    """

    items: list[CashflowOut]
    approved_income: Decimal = Decimal("0")
    approved_expense: Decimal = Decimal("0")
    approved_net: Decimal = Decimal("0")
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
    nature: str
    fund_nature: str | None = None
    accounting_attribute: str | None = None
    category: str
    amount: Decimal
    order_id: int | None = None
    note: str | None = None
    extra_values: dict[str, Any] | None = None
    # 表单字段配置体系（STUDIOEXP 作用域）：自定义字段值落 Cashflow.form_extra。
    form_extra: dict[str, Any] | None = None
    form_extra_scope: str = "FUNDFLOW"


class CashflowReverse(RequestModel):
    reversed_on: date
    reason: str
    # 表单字段配置体系（STUDIOREV 作用域）：落冲销流水 form_extra。
    form_extra: dict[str, Any] | None = None
    form_extra_scope: str = "FUNDREVERSE"


class ReconciliationCreate(RequestModel):
    pool_id: int
    reconciled_on: date
    account_label: str
    statement_balance: Decimal
    unmatched_flow_ids: list[int] = Field(default_factory=list)
    reason: str | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None


class ReconciliationResolve(RequestModel):
    reason: str
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


class TransferCreate(RequestModel):
    source_pool_id: int
    target_pool_id: int
    amount: Decimal
    occurred_on: date
    note: str | None = None
    form_extra: dict[str, Any] | None = None


class TransferRepair(RequestModel):
    counterpart_pool_id: int
    reason: str
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


class RebateCreate(RequestModel):
    source_order_id: int
    rebate_type: str = Field(description="BUY 买号返点 / SELL 卖号返点")
    # 省略时按 REBATE 规则的 config.base 从订单事件派生；显式传入始终优先。
    base_amount: Decimal | None = None
    collected_on: date
    rate: Decimal | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    channel: str | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None


class RebateUpdate(RequestModel):
    base_amount: Decimal | None = None
    rate: Decimal | None = None
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
    rate: Decimal
    base_amount: Decimal
    link_status: str
    status: str
    collected_on: date
    note: str | None = None
    created_at: datetime
    operator: str
    operator_user_ids: list[int] | None = None
    form_extra: dict[str, Any] | None = None
    # 累计已退由后端聚合下发（口径收敛，前端不再自行相减）；新返点为 0。
    already_returned: Decimal = Decimal("0")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def remaining(self) -> Decimal:
        """可退余额 = 返点金额 - 累计已退，夹底 0（与押金 remaining_amount 同构）。"""
        remaining = to_money(self.base_amount) - to_money(self.already_returned)
        return remaining if remaining > 0 else Decimal("0.00")


class RebateReturnIn(RequestModel):
    """返点退回：金额必填、退回日必填（自然归期），可分多次部分退回。"""

    amount: Decimal
    returned_on: date
    note: str | None = None


class RebateReturnOut(BaseModel):
    """退回结果：返点记录 + 退回形成的挂单 OUT 流水 + 累计已退。"""

    model_config = ConfigDict(from_attributes=True)

    rebate: RebateOut
    cashflow: CashflowOut
    already_returned: Decimal

    @computed_field  # type: ignore[prop-decorator]
    @property
    def remaining(self) -> Decimal:
        """退后可退余额直接取返点记录口径，避免两处各自相减。"""
        return self.rebate.remaining


__all__ = [
    "DepositCreate",
    "DepositOut",
    "DepositReturn",
    "DepositLoss",
    "CashflowOut",
    "CashflowListOut",
    "StudioSummaryOut",
    "CashflowCreate",
    "CashflowReverse",
    "ReconciliationCreate",
    "ReconciliationResolve",
    "ReconciliationOut",
    "TransferCreate",
    "TransferRepair",
    "TransferOut",
    "RebateCreate",
    "RebateOut",
    "RebateReturnIn",
    "RebateReturnOut",
]
