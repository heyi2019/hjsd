"""finance.schemas：押金与返点的请求/响应模型。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel


class DepositCreate(RequestModel):
    pool_id: int
    amount: Decimal
    paid_on: date
    counterparty_id: int | None = None
    source_order_id: int | None = None
    expected_release_on: date | None = None
    note: str | None = None


class PeriodLockCreate(RequestModel):
    period: str = Field(min_length=7, max_length=7)
    note: str | None = Field(default=None, max_length=500)


class PeriodLockOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    period: str
    locked_at: datetime
    locked_by: str
    note: str | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str
    updated_by: str


class DepositReturn(RequestModel):
    amount: Decimal
    released_on: date


class DepositLoss(RequestModel):
    amount: Decimal
    lost_on: date
    category: str
    reason: str


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


class CashflowListOut(BaseModel):
    """资金流水分页响应：返回本页明细与命中总数，便于前端判断是否还有更多。"""

    items: list[CashflowOut]
    total: int = Field(ge=0)


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


class CashflowReject(RequestModel):
    reason: str
    # 表单字段配置体系（STUDIOREJ 作用域）：合并进流水 form_extra。
    form_extra: dict[str, Any] | None = None


class CashflowReverse(RequestModel):
    reversed_on: date
    reason: str
    # 表单字段配置体系（STUDIOREV 作用域）：落冲销流水 form_extra。
    form_extra: dict[str, Any] | None = None


class ReconciliationCreate(RequestModel):
    pool_id: int
    reconciled_on: date
    account_label: str
    statement_balance: Decimal
    unmatched_flow_ids: list[int] = Field(default_factory=list)
    reason: str | None = None
    note: str | None = None


class ReconciliationResolve(RequestModel):
    reason: str


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


class TransferCreate(RequestModel):
    source_pool_id: int
    target_pool_id: int
    amount: Decimal
    occurred_on: date
    note: str | None = None


class TransferRepair(RequestModel):
    counterpart_pool_id: int
    reason: str


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
    expected_on: date | None = None
    rate: Decimal | None = None
    channel: str | None = None
    note: str | None = None


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
    expected_on: date | None = None
    note: str | None = None
    created_at: datetime
    operator: str


class RebateOverdueOut(RebateOut):
    overdue_days: int


class SettlementCreate(RequestModel):
    gross_amount: Decimal
    settled_on: date
    pool_id: int
    platform_fee: Decimal = Decimal("0")
    note: str | None = None


class SettlementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    settlement_no: str
    rebate_record_id: int
    gross_amount: Decimal
    platform_fee: Decimal
    net_amount: Decimal
    settled_on: date
    cashflow_id: int | None = None
    reversal_of_id: int | None = None
    note: str | None = None
    created_at: datetime
    operator: str


class SettlementReverse(RequestModel):
    reversed_on: date
    reason: str


__all__ = [
    "DepositCreate",
    "DepositOut",
    "DepositReturn",
    "DepositLoss",
    "PeriodLockCreate",
    "PeriodLockOut",
    "CashflowOut",
    "CashflowListOut",
    "CashflowCreate",
    "CashflowReject",
    "CashflowReverse",
    "ReconciliationCreate",
    "ReconciliationResolve",
    "ReconciliationOut",
    "TransferCreate",
    "TransferRepair",
    "TransferOut",
    "RebateCreate",
    "RebateOut",
    "SettlementCreate",
    "SettlementOut",
    "SettlementReverse",
]
