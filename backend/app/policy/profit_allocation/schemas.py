"""订单分润配置的请求与响应契约。"""
from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel


class ProfitAllocationItem(RequestModel):
    user_id: int | None = Field(default=None, gt=0)
    role: str = Field(default="OWNER", min_length=1, max_length=32)
    allocation_type: str | None = Field(default=None, max_length=16)
    allocation_rate: Decimal = Field(default=Decimal("0"), ge=0)
    allocation_amount: Decimal = Field(default=Decimal("0"))


class ProfitAllocationSet(RequestModel):
    items: list[ProfitAllocationItem] = Field(default_factory=list)
    form_extra: dict[str, object] | None = None


class ProfitAllocationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    order_id: int
    user_id: int | None = None
    role: str
    allocation_type: str | None = None
    allocation_rate: Decimal
    allocation_amount: Decimal = Decimal("0")
    policy_version_id: int | None = None
    total_rate: Decimal
    total_amount: Decimal = Decimal("0")


class ProfitAllocationListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ProfitAllocationOut]
    total: int
    order_profit: Decimal = Decimal("0")


__all__ = [
    "ProfitAllocationItem",
    "ProfitAllocationListOut",
    "ProfitAllocationOut",
    "ProfitAllocationSet",
]
