"""quality 异常工单服务（QLT-02）。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.numbering import allocate_number
from app.domain.enums import AuditAction, QualityIssueStatus, SequenceKey
from app.domain.quality import QualityIssue

def get_issue(session: Session, issue_id: int) -> QualityIssue:
    issue = session.get(QualityIssue, issue_id)
    if issue is None:
        raise NotFound("质量工单不存在", details={"issue_id": issue_id})
    return issue


def list_issues(
    session: Session,
    *,
    status: str | None = None,
    code: str | None = None,
) -> list[QualityIssue]:
    stmt = select(QualityIssue)
    if status is not None:
        try:
            QualityIssueStatus(status)
        except ValueError as exc:
            raise Validation(
                f"质量工单状态必须为 {QualityIssueStatus.values()}",
                details={"field": "status", "value": status},
            ) from exc
        stmt = stmt.where(QualityIssue.status == status)
    if code:
        stmt = stmt.where(QualityIssue.code == code)
    return list(session.scalars(stmt.order_by(QualityIssue.id.desc())).all())


def create_issue(
    session: Session,
    *,
    code: str,
    severity: str,
    title: str,
    entity_type: str,
    entity_id: str,
    message: str,
    actor: str,
    details: dict[str, Any] | None = None,
) -> QualityIssue:
    if severity.upper() not in {"CRITICAL", "HIGH", "MEDIUM", "LOW"}:
        raise Validation("质量工单严重级别无效", details={"field": "severity"})
    duplicate = session.scalar(
        select(QualityIssue).where(
            QualityIssue.code == code,
            QualityIssue.entity_type == entity_type,
            QualityIssue.entity_id == entity_id,
            QualityIssue.status != QualityIssueStatus.CLOSED.value,
        )
    )
    if duplicate is not None:
        raise Conflict(
            "同一对象的未关闭异常已存在",
            details={"issue_no": duplicate.issue_no},
        )
    issue = QualityIssue(
        issue_no=allocate_number(session, SequenceKey.QUALITY_ISSUE),
        code=code.strip(),
        severity=severity.upper(),
        title=title.strip(),
        entity_type=entity_type.strip(),
        entity_id=entity_id.strip(),
        message=message.strip(),
        details=details,
        status=QualityIssueStatus.OPEN.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(issue)
    session.flush()
    record_audit(
        session,
        action=AuditAction.QUALITY_ISSUE_CREATE,
        entity_type="quality_issue",
        entity_id=issue.issue_no,
        actor=actor,
        after={"code": issue.code, "entity_id": issue.entity_id},
    )
    return issue


def update_issue(
    session: Session,
    issue_id: int,
    *,
    status: str,
    actor: str,
) -> QualityIssue:
    issue = get_issue(session, issue_id)
    if issue.status == QualityIssueStatus.CLOSED.value:
        raise Conflict("已关闭质量工单不可更新", details={"issue_no": issue.issue_no})
    if status == QualityIssueStatus.CLOSED.value:
        raise Validation("关闭质量工单必须使用 close 接口")
    before = {"status": issue.status}
    issue.status = status
    issue.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.QUALITY_ISSUE_UPDATE,
        entity_type="quality_issue",
        entity_id=issue.issue_no,
        actor=actor,
        before=before,
        after={"status": issue.status},
    )
    return issue


def close_issue(
    session: Session,
    issue_id: int,
    *,
    resolution: str,
    evidence: str | None,
    actor: str,
) -> QualityIssue:
    issue = get_issue(session, issue_id)
    if issue.status == QualityIssueStatus.CLOSED.value:
        raise Conflict("质量工单已关闭", details={"issue_no": issue.issue_no})
    if not resolution.strip():
        raise Validation("关闭质量工单必须填写解决方式", details={"field": "resolution"})
    issue.status = QualityIssueStatus.CLOSED.value
    issue.resolution = resolution.strip()
    issue.evidence = evidence.strip() if evidence else None
    issue.closed_by = actor
    issue.closed_at = datetime.now()
    issue.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.QUALITY_ISSUE_CLOSE,
        entity_type="quality_issue",
        entity_id=issue.issue_no,
        actor=actor,
        after={"status": issue.status, "resolution": issue.resolution},
        reason=issue.resolution,
    )
    return issue

__all__ = [
    "close_issue",
    "create_issue",
    "get_issue",
    "list_issues",
    "update_issue",
]

