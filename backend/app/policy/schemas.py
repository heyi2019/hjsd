"""policy 请求契约：规则定义、版本与利润分配。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import Field

from app.core.schemas import RequestModel


class PolicyDefinitionCreate(RequestModel):
    policy_code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    scope_type: str = Field(default="GLOBAL", min_length=1, max_length=32)
    scope_id: int | None = Field(default=None, gt=0)
    description: str | None = None


class PolicyVersionCreate(RequestModel):
    effective_from: date
    effective_to: date | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    note: str | None = None


class PolicyVersionUpdate(RequestModel):
    config: dict[str, Any] = Field(default_factory=dict)


class PolicyVersionApprove(RequestModel):
    approver: str | None = Field(default=None, max_length=64)
    note: str | None = None


class ProfitAllocationItem(RequestModel):
    user_id: int = Field(gt=0)
    role: str = Field(min_length=1, max_length=32)
    allocation_rate: Decimal = Field(ge=0)


class ProfitAllocationSet(RequestModel):
    items: list[ProfitAllocationItem] = Field(default_factory=list)


__all__ = [
    "PolicyDefinitionCreate",
    "PolicyVersionApprove",
    "PolicyVersionCreate",
    "PolicyVersionUpdate",
    "ProfitAllocationSet",
]
