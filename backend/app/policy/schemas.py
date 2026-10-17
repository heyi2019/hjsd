"""policy 请求契约：规则定义、版本与利润分配。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

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
    user_id: int | None = Field(default=None, gt=0)
    role: str = Field(min_length=1, max_length=32)
    allocation_type: str = Field(min_length=1, max_length=16)
    allocation_rate: Decimal = Field(ge=0)


class ProfitAllocationSet(RequestModel):
    items: list[ProfitAllocationItem] = Field(default_factory=list)


class PolicyDefinitionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    policy_code: str
    name: str
    scope_type: str
    scope_id: int | None = None
    description: str | None = None
    status: str
    created_at: datetime | None = None


class PolicyDefinitionListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PolicyDefinitionOut]
    total: int


class PolicyVersionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    policy_definition_id: int
    version: int
    effective_from: date
    effective_to: date | None = None
    config: dict[str, Any]
    status: str
    approved_by: str | None = None
    approved_at: datetime | None = None
    note: str | None = None


class PolicyVersionListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PolicyVersionOut]
    total: int


class PolicyResolveOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    found: bool
    version: PolicyVersionOut | None = None


class ProfitAllocationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    order_id: int
    user_id: int | None = None
    role: str
    allocation_type: str | None = None
    allocation_rate: Decimal
    policy_version_id: int | None = None
    total_rate: Decimal


class ProfitAllocationListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ProfitAllocationOut]
    total: int


class PolicySnapshotOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policy_version_id: int | None = None
    policy_snapshot: dict[str, Any]


class OrderPolicySnapshotOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    found: bool
    snapshot: PolicySnapshotOut | None = None


__all__ = [
    "PolicyDefinitionCreate",
    "PolicyDefinitionListOut",
    "PolicyDefinitionOut",
    "PolicyResolveOut",
    "PolicySnapshotOut",
    "PolicyVersionApprove",
    "PolicyVersionCreate",
    "PolicyVersionListOut",
    "PolicyVersionOut",
    "PolicyVersionUpdate",
    "OrderPolicySnapshotOut",
    "ProfitAllocationListOut",
    "ProfitAllocationOut",
    "ProfitAllocationSet",
]
