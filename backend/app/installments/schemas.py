"""installments.schemas：分期合约与收款请求/响应模型。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel


class ScheduleCreate(RequestModel):
    period_no: int = Field(ge=1)
    due_on: date
    service_fee_rate: Decimal = Decimal("0")


class InstallmentCreate(RequestModel):
    order_id: int
    contract_type: str = Field(description="STOCK_SALE / ADVANCE_PURCHASE")
    principal: Decimal = Decimal("0")
    down_payment: Decimal = Decimal("0")
    service_fee: Decimal = Decimal("0")
    periods: int = Field(gt=0)
    per_period_service_fee: Decimal = Decimal("0")
    per_period: Decimal = Decimal("0")
    first_due_on: date
    delivery_mode: str | None = None
    note: str | None = None
    schedule: list[ScheduleCreate] | None = None
    extra_values: dict[str, Any] | None = None


class InstallmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    inst_no: str
    order_id: int
    contract_type: str
    principal: Decimal
    down_payment: Decimal
    service_fee: Decimal
    periods: int
    per_period_service_fee: Decimal
    per_period: Decimal
    paid_amount: Decimal
    waived_amount: Decimal
    status: str
    delivery_mode: str | None = None
    delivered_on: date | None = None
    first_due_on: date | None = None
    note: str | None = None
    extra_values: dict[str, Any] = Field(default_factory=dict)


class ScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    installment_id: int
    period_no: int
    due_on: date
    service_fee_rate: Decimal
    due_amount: Decimal
    received_amount: Decimal
    waived_amount: Decimal
    status: str


class PaymentIn(RequestModel):
    amount: Decimal
    paid_on: date
    period_no: int | None = None
    pool_id: int | None = None
    note: str | None = None


class EarlySettlementIn(RequestModel):
    paid_on: date
    pool_id: int | None = None
    note: str | None = None


class DefaultIn(RequestModel):
    reason: str = Field(min_length=1)


class DispositionIn(RequestModel):
    occurred_on: date
    note: str = Field(min_length=1)


class ResaleIn(DispositionIn):
    resale_order_id: int


class DispositionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    installment_id: int
    account_id: int
    action: str
    occurred_on: date
    related_order_id: int | None = None
    note: str


class ScheduleWaiveIn(RequestModel):
    amount: Decimal = Field(gt=0)
    waived_on: date
    reason: str = Field(min_length=1)


class ScheduleExtendIn(RequestModel):
    new_due_on: date
    reason: str = Field(min_length=1)


class DeliverIn(RequestModel):
    delivery_mode: str
    delivered_on: date
    note: str = Field(min_length=1, description="换绑凭证说明")


class PaymentResult(BaseModel):
    installment: InstallmentOut
    schedule: ScheduleOut


class MarkOverdueOut(BaseModel):
    marked: int


__all__ = [
    "DeliverIn",
    "DefaultIn",
    "DispositionIn",
    "DispositionOut",
    "EarlySettlementIn",
    "InstallmentCreate",
    "InstallmentOut",
    "MarkOverdueOut",
    "PaymentIn",
    "PaymentResult",
    "ScheduleExtendIn",
    "ScheduleWaiveIn",
    "ScheduleCreate",
    "ScheduleOut",
    "ResaleIn",
]
