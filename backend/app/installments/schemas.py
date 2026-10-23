"""installments.schemas：分期合约与收款请求/响应模型。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.core.money import to_money
from app.core.schemas import RequestModel


class ScheduleCreate(RequestModel):
    period_no: int = Field(ge=1)
    due_on: date
    service_fee_rate: Decimal = Decimal("0")


class InstallmentCreate(RequestModel):
    order_id: int
    contract_type: str = Field(
        description="STOCK_SALE / ADVANCE_PURCHASE / PICKUP_SALE / CONSIGNMENT_SALE"
    )
    principal: Decimal = Decimal("0")
    down_payment: Decimal = Decimal("0")
    service_fee: Decimal = Decimal("0")
    periods: int = Field(gt=0)
    per_period_service_fee: Decimal = Decimal("0")
    per_period: Decimal = Decimal("0")
    adjust_final_period: bool = False
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
    bad_debt_amount: Decimal
    final_period_adjustment: Decimal = Decimal("0")
    status: str
    delivery_mode: str | None = None
    delivered_on: date | None = None
    first_due_on: date | None = None
    note: str | None = None
    extra_values: dict[str, Any] = Field(default_factory=dict)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_receivable(self) -> Decimal:
        """总应收（口径唯一来源，前端只读不再自行计算）。

        与 service.total_receivable 保持一致：
        首付 + 每期 × 期数 + 末期调整 − 减免。
        """
        return (
            to_money(self.down_payment)
            + to_money(self.per_period) * int(self.periods)
            + to_money(self.final_period_adjustment or 0)
            - to_money(self.waived_amount)
        )


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


class CancelIn(RequestModel):
    cancelled_on: date
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


class InstallmentCancelResult(BaseModel):
    installment: InstallmentOut
    order_status: str
    account_status: str | None = None
    refund_amount: Decimal
    reversed_amount: Decimal
    cancel_event_ids: list[int] = Field(default_factory=list)


class MarkOverdueOut(BaseModel):
    marked: int


__all__ = [
    "DeliverIn",
    "CancelIn",
    "DefaultIn",
    "DispositionIn",
    "DispositionOut",
    "EarlySettlementIn",
    "InstallmentCreate",
    "InstallmentOut",
    "InstallmentCancelResult",
    "MarkOverdueOut",
    "PaymentIn",
    "PaymentResult",
    "ScheduleExtendIn",
    "ScheduleWaiveIn",
    "ScheduleCreate",
    "ScheduleOut",
    "ResaleIn",
]
