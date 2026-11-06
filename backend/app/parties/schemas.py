"""parties.schemas：客户、合作方、表单扩展字段的请求/响应模型。

联系方式对外**默认脱敏**；只有具备 `customer.contact.read` 且显式请求时才返回完整值。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel
from app.domain.enums import CounterpartyType, CustomerStatus, LeadType


class CustomerCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str = Field(min_length=1, max_length=128, description="称呼/昵称，必填")
    contact_name: str | None = Field(default=None, max_length=128)
    phone: str | None = Field(default=None, max_length=64)
    wechat: str | None = Field(default=None, max_length=128)
    qq: str | None = Field(default=None, max_length=64)
    source: str | None = Field(default=None, max_length=64)
    owner_id: int | None = None
    tags: list[str] | None = None
    note: str | None = None
    extra_values: dict[str, Any] | None = Field(
        default=None, description="表单扩展字段值：field_key → 值，仅接受已启用的字段配置（BAS-04-04）"
    )


class CustomerUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    owner_id: int | None = None
    tags: list[str] | None = None
    note: str | None = None
    extra_values: dict[str, Any] | None = None


class CustomerStatusUpdate(RequestModel):
    status: CustomerStatus
    # 状态变更同时可写扩展字段值（只校验本次提交的字段，不做全量必填校验）。
    extra_values: dict[str, Any] | None = None


class DuplicateCandidate(BaseModel):
    """重复候选：只提示，不拦截建档（CUS-01-05）。"""

    customer_id: int
    customer_no: str
    display_name: str
    matched_on: list[str]


class CustomerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_no: str
    display_name: str
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    owner_id: int | None = None
    status: str
    created_at: datetime
    tags: list[str] | None = None
    note: str | None = None
    merged_into_id: int | None = None
    contact_masked: bool = True
    extra_values: dict[str, Any] = Field(default_factory=dict)
    order_roles: list[str] = Field(default_factory=list)
    active_order_count: int = 0
    last_interaction_at: datetime | None = None


class CustomerWithCandidates(BaseModel):
    customer: CustomerOut
    duplicate_candidates: list[DuplicateCandidate] = Field(default_factory=list)


class CustomerOverviewOut(BaseModel):
    order_count: int
    active_order_count: int
    completed_order_count: int
    cancelled_order_count: int
    last_trade_date: date | None = None
    installment_paid_total: Decimal
    installment_receivable_total: Decimal
    installment_remaining_total: Decimal
    overdue_period_count: int


class CustomerBusinessOut(BaseModel):
    order_id: int
    order_no: str
    order_type: str
    status: str
    trade_date: date
    owner_id: int | None = None
    roles: list[str]


class CustomerInstallmentOut(BaseModel):
    id: int
    inst_no: str
    order_id: int
    order_no: str | None = None
    contract_type: str
    status: str
    principal: Decimal
    total_receivable: Decimal
    paid_amount: Decimal
    remaining_amount: Decimal
    overdue_periods: int
    first_due_on: date | None = None


class CustomerAuditOut(BaseModel):
    id: int
    action: str
    entity_type: str
    entity_id: str
    actor: str
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    reason: str | None = None
    request_id: str | None = None
    occurred_at: datetime


class CustomerDetailOut(BaseModel):
    customer: CustomerOut
    overview: CustomerOverviewOut
    business: list[CustomerBusinessOut]
    installments: list[CustomerInstallmentOut]
    audit: list[CustomerAuditOut]


class LeadCreate(RequestModel):
    customer_id: int = Field(gt=0)
    request_type: LeadType
    budget: Decimal | None = Field(default=None, ge=0)
    target: str = Field(min_length=1, max_length=2000)
    owner_id: int | None = Field(default=None, gt=0)
    note: str | None = Field(default=None, max_length=2000)
    extra_values: dict[str, Any] | None = None


class LeadUpdate(RequestModel):
    budget: Decimal | None = Field(default=None, ge=0)
    target: str | None = Field(default=None, min_length=1, max_length=2000)
    owner_id: int | None = Field(default=None, gt=0)
    note: str | None = Field(default=None, max_length=2000)
    extra_values: dict[str, Any] | None = None


class LeadConvert(RequestModel):
    order_id: int = Field(gt=0)
    extra_values: dict[str, Any] | None = None


class LeadClose(RequestModel):
    reason: str = Field(min_length=1, max_length=500)
    extra_values: dict[str, Any] | None = None


class LeadOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    lead_no: str
    customer_id: int
    request_type: str
    budget: Decimal | None = None
    target: str
    status: str
    owner_id: int | None = None
    converted_order_id: int | None = None
    closed_reason: str | None = None
    note: str | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str
    updated_by: str
    extra_values: dict[str, Any] = Field(default_factory=dict)


class MergeRequest(RequestModel):
    target_customer_id: int
    reason: str = Field(min_length=1, max_length=500)


class CounterpartyCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str = Field(min_length=1, max_length=128)
    type: CounterpartyType
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = Field(default=None, max_length=64)
    note: str | None = None
    extra_values: dict[str, Any] | None = None


class CounterpartyUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    note: str | None = None
    extra_values: dict[str, Any] | None = None


class CounterpartyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    counterparty_no: str
    display_name: str
    type: str
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    status: str
    note: str | None = None
    created_at: datetime
    extra_values: dict[str, Any] = Field(default_factory=dict)


class ExtraValueIn(RequestModel):
    field_key: str
    value: str | int | float | bool | list | dict | None = None


__all__ = [
    "CounterpartyCreate",
    "CounterpartyOut",
    "CounterpartyUpdate",
    "CustomerCreate",
    "CustomerAuditOut",
    "CustomerBusinessOut",
    "CustomerDetailOut",
    "CustomerOut",
    "CustomerOverviewOut",
    "CustomerInstallmentOut",
    "CustomerStatusUpdate",
    "CustomerUpdate",
    "CustomerWithCandidates",
    "DuplicateCandidate",
    "ExtraValueIn",
    "MergeRequest",
    "LeadClose",
    "LeadConvert",
    "LeadCreate",
    "LeadOut",
    "LeadUpdate",
]
