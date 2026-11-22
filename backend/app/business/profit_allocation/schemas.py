"""订单分润配置的请求与响应契约。"""
from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel


class ProfitAllocationItem(RequestModel):
    user_id: int | None = Field(default=None, gt=0)
    employee_ids: list[int] = Field(default_factory=list)
    role: str = Field(default="OWNER", min_length=1, max_length=32)
    allocation_type: str | None = Field(default=None, max_length=16)
    allocation_rate: Decimal | None = Field(default=Decimal("0"), ge=0)
    allocation_amount: Decimal | None = Field(default=Decimal("0"))


class ProfitAllocationSet(RequestModel):
    items: list[ProfitAllocationItem] = Field(default_factory=list)
    form_extra: dict[str, object] | None = None


class ProfitAllocationConvertIn(RequestModel):
    direction: Literal["RATE_TO_AMOUNT", "AMOUNT_TO_RATE"]
    value: Decimal


class ProfitAllocationConvertOut(BaseModel):
    value: Decimal | None


class CompanyProfitSettingsIn(RequestModel):
    profit_rate: Decimal = Field(ge=0, le=100, decimal_places=2)
    loss_rate: Decimal = Field(ge=0, le=100, decimal_places=2)


class CompanyProfitSettingsOut(BaseModel):
    profit_rate: Decimal
    loss_rate: Decimal


class ProfitAllocationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    order_id: int
    user_id: int | None = None
    role: str
    allocation_type: str | None = None
    allocation_rate: Decimal
    allocation_amount: Decimal = Decimal("0")
    total_rate: Decimal
    total_amount: Decimal = Decimal("0")


class ProfitAllocationTypeTotal(BaseModel):
    allocation_rate: Decimal = Decimal("0")
    allocation_amount: Decimal = Decimal("0")


class ProfitAllocationListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ProfitAllocationOut]
    total: int
    order_profit: Decimal = Decimal("0")
    company_rate: Decimal = Decimal("40")
    allocatable_profit: Decimal = Decimal("0")
    totals_by_type: dict[str, ProfitAllocationTypeTotal] = Field(default_factory=dict)


__all__ = [
    "ProfitAllocationItem",
    "ProfitAllocationConvertIn",
    "ProfitAllocationConvertOut",
    "ProfitAllocationListOut",
    "ProfitAllocationOut",
    "ProfitAllocationTypeTotal",
    "ProfitAllocationSet",
]
