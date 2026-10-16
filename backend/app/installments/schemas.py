"""installments.schemas：分期合约与收款请求/响应模型。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class ScheduleCreate(BaseModel):
    period_no: int = Field(ge=1)
    due_on: date


class InstallmentCreate(BaseModel):
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
    status: str
    delivery_mode: str | None = None
    delivered_on: date | None = None


class ScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    installment_id: int
    period_no: int
    due_on: date
    due_amount: Decimal
    received_amount: Decimal
    status: str


class PaymentIn(BaseModel):
    amount: Decimal
    paid_on: date
    period_no: int | None = None
    pool_id: int | None = None
    note: str | None = None


class DeliverIn(BaseModel):
    delivery_mode: str
    delivered_on: date
    note: str = Field(min_length=1, description="换绑凭证说明")


class PaymentResult(BaseModel):
    installment: InstallmentOut
    schedule: ScheduleOut


__all__ = [
    "DeliverIn",
    "InstallmentCreate",
    "InstallmentOut",
    "PaymentIn",
    "PaymentResult",
    "ScheduleCreate",
    "ScheduleOut",
]
