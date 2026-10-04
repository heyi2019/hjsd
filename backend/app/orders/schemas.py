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


class EventCreate(BaseModel):
    event_type: str
    amount: Decimal = Field(default=Decimal("0"))
    occurred_on: date
    pool_id: int | None = Field(default=None, description="显式池优先于默认路由")
    portion: str = "PRINCIPAL"
    delivery_mode: str | None = None
    offset_event_id: int | None = None
    reason: str | None = None
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


class TransferCreate(BaseModel):
    source_pool_id: int
    target_pool_id: int
    amount: Decimal
    occurred_on: date
    note: str | None = None


class TransferOut(BaseModel):
    transfer_id: str
    out_flow_no: str
    in_flow_no: str
    amount: Decimal


class PoolBalanceOut(BaseModel):
    pool_id: int
    pool_code: str
    income: Decimal
    expense: Decimal
    transfer_in: Decimal
    transfer_out: Decimal
    cash_balance: Decimal
    deposit_held: Decimal
    th_advance: Decimal
    available: Decimal


__all__ = [
    "EventCreate",
    "EventOut",
    "EventPostResult",
    "OrderCreate",
    "OrderOut",
    "PartyRole",
    "PoolBalanceOut",
    "TransferCreate",
    "TransferOut",
]
