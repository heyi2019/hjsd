"""订单分润配置的请求与响应契约。"""
from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    amounts_changed: bool | None = None
    rates_changed: bool = False
    expected_order_profit: Decimal | None = Field(default=None, decimal_places=2)

    @model_validator(mode="after")
    def require_grouped_form_state(self):
        grouped = [item for item in self.items if item.allocation_type]
        if grouped and self.amounts_changed is None:
            raise ValueError("按动作分润必须提供金额修改状态")
        if self.amounts_changed is not None and len(grouped) != len(self.items):
            raise ValueError("金额修改状态仅用于按动作分润")
        if self.expected_order_profit is not None and self.amounts_changed is None:
            raise ValueError("利润校验仅用于按动作分润")
        if self.rates_changed and self.amounts_changed is None:
            raise ValueError("比例修改状态仅用于按动作分润")
        return self


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


class ActionCandidatesOut(BaseModel):
    BUY: list[int]
    SELL: list[int]
    OPERATION: list[int]
    COMPANY: list[int]


class AllocationFormRowOut(BaseModel):
    allocation_type: Literal["BUY", "SELL", "OPERATION", "COMPANY"]
    employee_ids: list[int]
    role: str
    allocation_rate: str
    allocation_amount: str


class ProfitAllocationListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ProfitAllocationOut]
    total: int
    order_profit: Decimal
    company_rate: Decimal
    allocatable_profit: Decimal
    totals_by_type: dict[str, ProfitAllocationTypeTotal]
    action_candidates: ActionCandidatesOut
    form_rows: list[AllocationFormRowOut]


__all__ = [
    "ProfitAllocationItem",
    "ProfitAllocationConvertIn",
    "ProfitAllocationConvertOut",
    "ProfitAllocationListOut",
    "ProfitAllocationOut",
    "ProfitAllocationTypeTotal",
    "ProfitAllocationSet",
]
