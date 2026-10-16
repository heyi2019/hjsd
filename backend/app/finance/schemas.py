"""finance.schemas：押金与返点的请求/响应模型。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class DepositCreate(BaseModel):
    pool_id: int
    amount: Decimal
    paid_on: date
    counterparty_id: int | None = None
    source_order_id: int | None = None
    expected_release_on: date | None = None
    note: str | None = None


class DepositReturn(BaseModel):
    amount: Decimal
    released_on: date


class DepositOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    pool_id: int
    paid_amount: Decimal
    returned_amount: Decimal
    status: str
    paid_on: date
    released_on: date | None = None


class CashflowOut(BaseModel):
    id: int
    flow_no: str
    pool_id: int
    occurred_on: date
    nature: str
    category: str
    direction: str
    amount: Decimal
    order_id: int | None = None
    order_no: str | None = None
    deposit_id: int | None = None
    order_event_id: int | None = None
    transfer_id: str | None = None
    source: str
    note: str | None = None


class TransferCreate(BaseModel):
    source_pool_id: int
    target_pool_id: int
    amount: Decimal
    occurred_on: date
    note: str | None = None


class TransferOut(BaseModel):
    transfer_id: str
    source_pool_id: int
    target_pool_id: int
    amount: Decimal
    occurred_on: date
    cashflows: list[CashflowOut]


class RebateCreate(BaseModel):
    source_order_id: int
    base_amount: Decimal
    collected_on: date
    rate: Decimal = Decimal("0")
    channel: str | None = None
    note: str | None = None


class RebateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rebate_no: str
    source_order_id: int | None = None
    rate: Decimal
    base_amount: Decimal
    status: str
    collected_on: date


class SettlementCreate(BaseModel):
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


__all__ = [
    "DepositCreate",
    "DepositOut",
    "DepositReturn",
    "CashflowOut",
    "TransferCreate",
    "TransferOut",
    "RebateCreate",
    "RebateOut",
    "SettlementCreate",
    "SettlementOut",
]
