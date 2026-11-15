"""订单详情接口的响应契约。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.stocks.schemas import AccountOut
from .schemas import OrderDetailViewOut


class ExecutionCashflowOut(BaseModel):
    flow_no: str
    pool_name: str | None = None
    occurred_on: date
    occurred_at: datetime
    direction: str
    nature: str
    category: str
    amount: Decimal
    note: str | None = None
    operator: str


class ExecutionEventOut(BaseModel):
    id: int
    event_no: str
    event_type: str
    operation_type: str | None = None
    rebate_type: str | None = None
    amount: Decimal
    cancellable_amount: Decimal = Decimal("0")
    occurred_on: date
    occurred_at: datetime
    created_at: datetime
    posted_at: datetime | None = None
    pool_id: int | None = None
    offset_event_id: int | None = None
    portion: str
    delivery_mode: str | None = None
    delivery_direction: str | None = None
    is_posted: bool
    reason: str | None = None
    note: str | None = None
    form_extra: dict[str, object] = Field(default_factory=dict)
    cashflow: ExecutionCashflowOut | None = None
    operator: str
    operator_user_ids: list[int] | None = None
    operator_names: list[str] = Field(default_factory=list)


class ExecutionCounterpartyOut(BaseModel):
    id: int
    display_name: str
    role: str


class ExecutionCustomerOut(BaseModel):
    id: int
    display_name: str
    role: str


class ExecutionRebateOut(BaseModel):
    id: int
    rebate_no: str
    rebate_type: str
    channel: str | None = None
    amount: Decimal
    status: str
    collected_on: date
    collected_at: datetime


class AccountExecutionOrderOut(BaseModel):
    order_id: int
    order_no: str
    order_type: str
    trade_date: date
    created_at: datetime
    status: str
    account_platform: str | None = None
    note: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    extra_fields: list[dict[str, object]] = Field(default_factory=list)
    cashflows: list[ExecutionCashflowOut] = Field(default_factory=list)
    customers: list[ExecutionCustomerOut] = Field(default_factory=list)
    counterparties: list[ExecutionCounterpartyOut] = Field(default_factory=list)
    rebates: list[ExecutionRebateOut] = Field(default_factory=list)
    events: list[ExecutionEventOut]
    operator: str


class AccountAuditOut(BaseModel):
    id: int
    action: str
    entity_type: str
    entity_id: str
    actor: str
    reason: str | None = None
    occurred_at: datetime


class ExecutionFinanceSummaryOut(BaseModel):
    cashflow_income: Decimal
    rebate_income: Decimal
    total_income: Decimal
    total_expense: Decimal
    net_amount: Decimal


class AccountExecutionDetailOut(BaseModel):
    account: AccountOut
    orders: list[AccountExecutionOrderOut]
    finance_summary: ExecutionFinanceSummaryOut
    detail_view: OrderDetailViewOut
    audit: list[AccountAuditOut] = Field(default_factory=list)
