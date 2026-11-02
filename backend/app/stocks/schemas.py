"""accounts.schemas：账号台账 API 的请求/响应模型（ACC-01）。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import PageOut, RequestModel

class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    stock_no: str | None = None
    source_order_id: int | None = None
    source_order_no: str | None = None
    game_account: str | None = None
    camp_account: str | None = None
    game_type: str | None = None
    business_mode: str | None = None
    inventory_type: str | None = None
    value_added_service: str | None = None
    game_password: str | None = None
    channel_region: str | None = None
    bound_phone: str | None = None
    has_secondary: bool | None = None
    secondary_images: list[str] | None = None
    wallet_realname: str | None = None
    wallet_realname_images: list[str] | None = None
    platform: str | None = None
    note: str | None = None
    account_description: str | None = None
    account_images: list[str] | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    status: str
    inventory_status: str
    inventory_entry_at: datetime
    cost_amount: Decimal
    buy_date: date | None = None
    created_by: str
    inventory_operator: str | None = None
    created_at: datetime


class AccountListOut(PageOut[AccountOut]):
    pass


class AccountProfileUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    game_account: str | None = Field(default=None, max_length=128)
    camp_account: str | None = Field(default=None, max_length=128)
    game_type: str | None = Field(default=None, max_length=64)
    game_password: str | None = Field(default=None, max_length=256)
    channel_region: str | None = Field(default=None, max_length=128)
    bound_phone: str | None = Field(default=None, max_length=64)
    has_secondary: bool | None = None
    secondary_images: list[str] | None = Field(default=None, max_length=3)
    wallet_realname: str | None = Field(default=None, max_length=16)
    wallet_realname_images: list[str] | None = Field(default=None, max_length=3)
    platform: str | None = Field(default=None, max_length=64)
    account_description: str | None = Field(default=None, max_length=2000)
    account_images: list[str] | None = Field(default=None, max_length=9)
    note: str | None = None
    extra_values: dict[str, object] | None = None
    # 表单字段配置体系（INVEDIT 作用域）：合并进账号 form_extra。
    form_extra: dict[str, object] | None = None


class ExecutionEditItem(RequestModel):
    id: int = Field(gt=0)
    expected_amount: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    amount: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    note: str | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class ExecutionEditRequest(RequestModel):
    events: list[ExecutionEditItem] = Field(max_length=100)
    profile: AccountProfileUpdate | None = None


class AccountInventoryOut(BaseModel):
    """库存健康接口的单行契约；与账号台账共享同一业务字段语义。"""

    model_config = ConfigDict(extra="forbid")

    account_id: int
    stock_no: str | None = None
    game_account: str | None = None
    business_mode: str | None = None
    inventory_type: str | None = None
    value_added_service: str | None = None
    platform: str | None = None
    status: str
    inventory_status: str
    inventory_entry_at: datetime
    cost_amount: Decimal
    account_description: str | None = None
    account_images: list[str] = Field(default_factory=list)
    extra_values: dict[str, object] = Field(default_factory=dict)


class InventoryResponseOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[AccountInventoryOut]
    count: int
    total_cost: Decimal


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
    amount: Decimal
    occurred_on: date
    occurred_at: datetime
    created_at: datetime
    posted_at: datetime | None = None
    pool_id: int | None = None
    offset_event_id: int | None = None
    portion: str
    delivery_mode: str | None = None
    is_posted: bool
    reason: str | None = None
    note: str | None = None
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
    rate: Decimal
    base_amount: Decimal
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


class AccountExecutionDetailOut(BaseModel):
    account: AccountOut
    orders: list[AccountExecutionOrderOut]
    audit: list[AccountAuditOut] = Field(default_factory=list)

__all__ = [
    "AccountOut",
    "AccountListOut",
    "AccountProfileUpdate",
    "ExecutionEditItem",
    "ExecutionEditRequest",
    "AccountInventoryOut",
    "InventoryResponseOut",
    "ExecutionCashflowOut",
    "ExecutionEventOut",
    "ExecutionCounterpartyOut",
    "ExecutionCustomerOut",
    "ExecutionRebateOut",
    "AccountExecutionOrderOut",
    "AccountAuditOut",
    "AccountExecutionDetailOut",
]
