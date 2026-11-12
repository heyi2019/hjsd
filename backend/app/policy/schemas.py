"""policy 请求契约：规则定义、版本与利润分配。"""
from __future__ import annotations

from datetime import date, datetime
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


class PolicyVersionSupersede(RequestModel):
    reason: str = Field(min_length=1, max_length=2000)
    replaced_by_version_id: int | None = Field(default=None, gt=0)


class PolicyExpireSweepOut(BaseModel):
    swept: int
    version_ids: list[int]
    on: date


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
    "PolicyVersionCreate",
    "PolicyVersionListOut",
    "PolicyVersionOut",
    "PolicyVersionUpdate",
    "OrderPolicySnapshotOut",
]
