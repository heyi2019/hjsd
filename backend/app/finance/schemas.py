"""finance.schemas：押金与返点的请求/响应模型。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

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
    paid_amount: Decimal
    returned_amount: Decimal
    lost_amount: Decimal
    status: str
    paid_on: date
    released_on: date | None = None
    lost_on: date | None = None


class CashflowOut(BaseModel):
    id: int
    flow_no: str
    pool_id: int
    occurred_on: date
    nature: str
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


class CashflowCreate(RequestModel):
    pool_id: int
    occurred_on: date
    direction: str
    nature: str
    category: str
    amount: Decimal
    order_id: int | None = None
    note: str | None = None


class CashflowReject(RequestModel):
    reason: str


class CashflowReverse(RequestModel):
    reversed_on: date
    reason: str


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
    cashflows: list[CashflowOut]


class RebateCreate(RequestModel):
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


class SettlementReverse(RequestModel):
    reversed_on: date
    reason: str


__all__ = [
    "DepositCreate",
    "DepositOut",
    "DepositReturn",
    "DepositLoss",
    "CashflowOut",
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
