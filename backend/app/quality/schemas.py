"""QLT-01 异常工单接口模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel
from app.domain.enums import QualityIssueStatus


class QualityIssueCreate(RequestModel):
    code: str = Field(min_length=1, max_length=64)
    severity: str = Field(min_length=1, max_length=16)
    title: str = Field(min_length=1, max_length=256)
    entity_type: str = Field(min_length=1, max_length=64)
    entity_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=4000)
    details: dict[str, Any] | None = None
    assignee_id: int | None = Field(default=None, gt=0)


class QualityIssueUpdate(RequestModel):
    assignee_id: int | None = Field(default=None, gt=0)
    status: QualityIssueStatus


class QualityIssueClose(RequestModel):
    resolution: str = Field(min_length=1, max_length=4000)
    evidence: str | None = Field(default=None, max_length=4000)


class QualityIssueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    issue_no: str
    code: str
    severity: str
    title: str
    entity_type: str
    entity_id: str
    message: str
    details: dict[str, Any] | None = None
    status: str
    assignee_id: int | None = None
    resolution: str | None = None
    evidence: str | None = None
    closed_by: str | None = None
    closed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str
    updated_by: str


__all__ = [
    "QualityIssueClose",
    "QualityIssueCreate",
    "QualityIssueOut",
    "QualityIssueUpdate",
]
