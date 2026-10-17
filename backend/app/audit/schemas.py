"""审计查询响应模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class AuditLogOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    action: str
    entity_type: str
    entity_id: str
    actor: str
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    reason: str | None = None
    request_id: str | None = None
    occurred_at: datetime | None = None


class AuditLogListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[AuditLogOut]
    total: int


class AuditActionListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[str]


__all__ = ["AuditActionListOut", "AuditLogListOut", "AuditLogOut"]
