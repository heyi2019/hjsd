"""audit.router：审计日志查询（BAS-05-03）。只读，且 details 不含敏感字段。"""
from __future__ import annotations

from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_AUDIT_READ,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.domain.foundation import AuditLog
from app.settings.audit import schemas

router = APIRouter(tags=["audit"])
read_access = require_permissions(PERM_AUDIT_READ)


@router.get("/audit-logs", response_model=schemas.AuditLogListOut)
def list_audit_logs(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    entity_type: str | None = Query(default=None),
    entity_id: str | None = Query(default=None),
    action: str | None = Query(default=None),
    actor: str | None = Query(default=None),
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> schemas.AuditLogListOut:
    """按对象、动作、操作人、时间查询审计轨迹。"""
    del user
    stmt = select(AuditLog).order_by(AuditLog.id.desc())
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if action:
        stmt = stmt.where(AuditLog.action == action.upper())
    if actor:
        stmt = stmt.where(AuditLog.actor == actor)
    if from_date:
        stmt = stmt.where(AuditLog.occurred_at >= datetime.combine(from_date, datetime.min.time()))
    if to_date:
        stmt = stmt.where(AuditLog.occurred_at <= datetime.combine(to_date, datetime.max.time()))
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    rows = db.scalars(stmt.order_by(AuditLog.id.desc()).limit(limit).offset(offset)).all()
    return schemas.AuditLogListOut(
        items=[
            schemas.AuditLogOut(
                id=row.id,
                action=row.action,
                entity_type=row.entity_type,
                entity_id=row.entity_id,
                actor=row.actor,
                before=row.before_json,
                after=row.after_json,
                reason=row.reason,
                request_id=row.request_id,
                occurred_at=row.occurred_at,
            )
            for row in rows
        ],
        total=total,
    )


@router.get("/audit-logs/stats", response_model=schemas.AuditEntityStatsOut)
def stats_audit_logs(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    entity_types: str = Query(default="", description="逗号分隔的 entity_type 清单"),
) -> schemas.AuditEntityStatsOut:
    """按 entity_type 汇总**真实**累计条数与最近一条改动。

    entity_types 走逗号分隔而非 FastAPI 重复参数：前端 axios 默认把数组序列化成
    `key[]=v`，与重复参数约定不兼容，逗号串更简单稳定。
    """
    del user
    wanted = [item.strip() for item in entity_types.split(",") if item.strip()]
    if not wanted:
        return schemas.AuditEntityStatsOut(items=[])
    grouped = (
        select(AuditLog.entity_type.label("entity_type"), func.count().label("total_count"), func.max(AuditLog.id).label("last_id"))
        .where(AuditLog.entity_type.in_(set(wanted)))
        .group_by(AuditLog.entity_type)
        .subquery()
    )
    results = {
        row.entity_type: row
        for row in db.execute(
            select(grouped.c.entity_type, grouped.c.total_count, AuditLog.occurred_at, AuditLog.actor)
            .join(AuditLog, AuditLog.id == grouped.c.last_id)
        )
    }
    items: list[schemas.AuditEntityStatOut] = []
    for entity_type in wanted:
        row = results.get(entity_type)
        items.append(
            schemas.AuditEntityStatOut(
                entity_type=entity_type,
                count=int(row.total_count) if row else 0,
                last_at=row.occurred_at if row else None,
                last_actor=row.actor if row else None,
            )
        )
    return schemas.AuditEntityStatsOut(items=items)


@router.get("/audit-logs/actions", response_model=schemas.AuditActionListOut)
def list_actions(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> schemas.AuditActionListOut:
    del db, user
    from app.domain.enums import AuditAction

    return schemas.AuditActionListOut(items=[action.value for action in AuditAction])


__all__ = ["router"]
