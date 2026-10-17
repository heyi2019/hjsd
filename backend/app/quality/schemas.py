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


class QualityIssueListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[QualityIssueOut]
    total: int = Field(ge=0)


class QualityScanItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    severity: str
    title: str
    entity_type: str
    entity_id: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class QualitySummaryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: int = Field(ge=0)
    by_severity: dict[str, int]
    by_code: dict[str, int]
    items: list[QualityScanItemOut]


class QualityMetricDefinitionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    formula: str
    unit: str


class QualityMetricValueOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rate: float | None = None
    numerator: int | None = Field(default=None, ge=0)
    denominator: int | None = Field(default=None, ge=0)
    amount: str | None = None


class QualityMetricItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    month: str
    linked_rebate_rate: QualityMetricValueOut
    reconciliation_completion_rate: QualityMetricValueOut
    overdue_rate: QualityMetricValueOut
    th_outstanding_amount: QualityMetricValueOut
    missing_attachment_rate: QualityMetricValueOut


class QualityMetricsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_: str = Field(alias="from")
    to: str
    definitions: dict[str, QualityMetricDefinitionOut]
    items: list[QualityMetricItemOut]


__all__ = [
    "QualityIssueClose",
    "QualityIssueCreate",
    "QualityIssueListOut",
    "QualityIssueOut",
    "QualityScanItemOut",
    "QualityIssueUpdate",
    "QualityMetricDefinitionOut",
    "QualityMetricItemOut",
    "QualityMetricValueOut",
    "QualityMetricsOut",
    "QualitySummaryOut",
]
