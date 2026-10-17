"""QLT-01 质量与异常工作台只读接口。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_ORDER_EXCEPTION_APPROVE,
    PERM_REPORT_READ,
    CurrentUser,
    require_permissions,
)
from app.quality import schemas, service

router = APIRouter(tags=["QLT-01 质量与异常"])
read_quality = require_permissions(PERM_REPORT_READ)
manage_quality = require_permissions(PERM_ORDER_EXCEPTION_APPROVE)


def _actor(user: CurrentUser) -> str:
    return user.username


@router.get("/quality/exceptions", response_model=schemas.QualitySummaryOut)
def list_quality_exceptions(
    db: Session = Depends(get_db), user: CurrentUser = read_quality
) -> schemas.QualitySummaryOut:
    return schemas.QualitySummaryOut.model_validate(service.summary(db, user=user))


@router.get("/quality/metrics", response_model=schemas.QualityMetricsOut)
def quality_metrics(
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
    user: CurrentUser = read_quality,
) -> schemas.QualityMetricsOut:
    """按月返回质量指标及其计算口径，数据范围与质量中心一致。"""
    return schemas.QualityMetricsOut.model_validate(
        service.metrics(db, from_date=from_date, to_date=to_date, user=user)
    )


@router.get("/quality/issues", response_model=schemas.QualityIssueListOut)
def list_quality_issues(
    status: str | None = Query(default=None),
    assignee_id: int | None = Query(default=None, gt=0),
    code: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_quality,
) -> schemas.QualityIssueListOut:
    items = service.list_issues(db, status=status, assignee_id=assignee_id, code=code)
    return schemas.QualityIssueListOut(
        items=[schemas.QualityIssueOut.model_validate(item) for item in items],
        total=len(items),
    )


@router.get("/quality/issues/{issue_id}", response_model=schemas.QualityIssueOut)
def get_quality_issue(
    issue_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_quality,
) -> schemas.QualityIssueOut:
    return schemas.QualityIssueOut.model_validate(service.get_issue(db, issue_id))


@router.post("/quality/issues", response_model=schemas.QualityIssueOut, status_code=201)
def create_quality_issue(
    payload: schemas.QualityIssueCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_quality,
) -> schemas.QualityIssueOut:
    item = service.create_issue(
        db,
        code=payload.code,
        severity=payload.severity,
        title=payload.title,
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        message=payload.message,
        details=payload.details,
        assignee_id=payload.assignee_id,
        actor=_actor(user),
    )
    return schemas.QualityIssueOut.model_validate(item)


@router.patch("/quality/issues/{issue_id}", response_model=schemas.QualityIssueOut)
def update_quality_issue(
    issue_id: int,
    payload: schemas.QualityIssueUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_quality,
) -> schemas.QualityIssueOut:
    item = service.update_issue(
        db,
        issue_id,
        assignee_id=payload.assignee_id,
        status=payload.status.value,
        actor=_actor(user),
    )
    return schemas.QualityIssueOut.model_validate(item)


@router.post("/quality/issues/{issue_id}/close", response_model=schemas.QualityIssueOut)
def close_quality_issue(
    issue_id: int,
    payload: schemas.QualityIssueClose,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_quality,
) -> schemas.QualityIssueOut:
    item = service.close_issue(
        db,
        issue_id,
        resolution=payload.resolution,
        evidence=payload.evidence,
        actor=_actor(user),
    )
    return schemas.QualityIssueOut.model_validate(item)


__all__ = ["router"]
