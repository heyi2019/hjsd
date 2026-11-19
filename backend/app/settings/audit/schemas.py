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


class AuditEntityStatOut(BaseModel):
    """单个 entity_type 的聚合结果。

    注：`AuditLogListOut.total` 语义是「当前页行数」（= len(items)），不是总数，
    拿它当累计次数会得到错误数字。需要真实累计数请用 /audit-logs/stats。
    """

    model_config = ConfigDict(extra="forbid")

    entity_type: str
    count: int
    last_at: datetime | None = None
    last_actor: str | None = None


class AuditEntityStatsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[AuditEntityStatOut]


__all__ = [
    "AuditActionListOut",
    "AuditEntityStatOut",
    "AuditEntityStatsOut",
    "AuditLogListOut",
    "AuditLogOut",
]
