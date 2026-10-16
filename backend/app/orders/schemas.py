"""orders.schemas：订单、事件、划转的请求/响应模型。

金额一律以字符串传输（如 `"1400.00"`），后端转 `Decimal`，禁止 float 参与计算（V15）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class PartyRole(BaseModel):
    customer_id: int | None = None
    counterparty_id: int | None = None
    role: str


class OrderCreate(BaseModel):
    order_type: str = Field(min_length=2, max_length=10, description="HS / TH / DG / DFQ")
    trade_date: date
    account_id: int | None = None
    owner_id: int | None = None
    capital_type: str | None = Field(default=None, description="默认取业务定义")
    note: str | None = None
    customer_roles: list[PartyRole] = Field(default_factory=list)
    counterparty_roles: list[PartyRole] = Field(default_factory=list)


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    order_no: str
    order_type: str
    capital_type: str
    trade_date: date
    account_id: int | None = None
    status: str
    link_status: str
    owner_id: int | None = None
    note: str | None = None
    created_at: datetime


class OrderListOut(OrderOut):
    """工作台列表摘要：主订单之外只带列表需要的可读业务信息。"""

    account_game_type: str | None = None
    account_game_account: str | None = None
    account_channel_region: str | None = None
    account_business_mode: str | None = None
    account_platform: str | None = None
    account_status: str | None = None
    party_name: str | None = None
    party_role: str | None = None
    party_source: str | None = None
    party_created_by: str | None = None
    party_created_at: datetime | None = None
    event_total: Decimal | None = None
    last_event_type: str | None = None
    last_event_amount: Decimal | None = None
    last_event_on: date | None = None
    installment_principal: Decimal | None = None
    installment_paid: Decimal | None = None
    installment_periods: int | None = None
    installment_status: str | None = None


class EventCreate(BaseModel):
    event_type: str
    amount: Decimal = Field(default=Decimal("0"))
    occurred_on: date
    pool_id: int | None = Field(default=None, description="显式池优先于默认路由")
    portion: str = "PRINCIPAL"
    delivery_mode: str | None = None
    offset_event_id: int | None = None
    reason: str | None = None
    flow_category: str | None = Field(
        default=None, description="COST 时可填 FEE / DESIGN / OTHER"
    )
    note: str | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_no: str
    order_id: int
    event_type: str
    amount: Decimal
    occurred_on: date
    pool_id: int | None = None
    portion: str
    delivery_mode: str | None = None
    is_posted: bool


class EventPostResult(BaseModel):
    event: EventOut
    cashflow_no: str | None = None


class PoolBalanceOut(BaseModel):
    pool_id: int
    pool_code: str
    income: Decimal
    expense: Decimal
    cash_balance: Decimal
    deposit_held: Decimal
    available: Decimal


__all__ = [
    "EventCreate",
    "EventOut",
    "EventPostResult",
    "OrderCreate",
    "OrderOut",
    "OrderListOut",
    "PartyRole",
    "PoolBalanceOut",
]
