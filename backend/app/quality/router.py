"""quality.router：异常工作台与校验任务（QLT-01）。

权限：查看 `quality.read`，处置/关闭 `quality.resolve`。
"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_QUALITY_READ,
    PERM_QUALITY_RESOLVE,
    CurrentUser,
    get_current_user,
    require_permissions,
)
from app.core.security import PERM_QUALITY_READ, PERM_QUALITY_RESOLVE
from app.quality import service

router = APIRouter(tags=["quality"])

read_access = require_permissions(PERM_QUALITY_READ)
resolve_access = require_permissions(PERM_QUALITY_RESOLVE)


@router.get("/quality/overview")
def quality_overview(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = Depends(get_current_user),
    _ok: CurrentUser = read_access,
) -> dict:
    """异常总览：每类异常的数量、等级与跳转入口（QLT-01-01）。"""
    del user
    return service.overview(db)


@router.post("/quality/detect")
def run_detection(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = Depends(get_current_user),
    _ok: CurrentUser = resolve_access,
) -> dict:
    """跑一遍全部检测规则；可每日复跑，工单幂等不重复开。"""
    return service.run_detection(db, actor=user.username)


@router.get("/quality/issues")
def list_issues(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = Depends(get_current_user),
    _ok: CurrentUser = read_access,
    issue_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    severity: str | None = Query(default=None),
    detected_from: date | None = Query(default=None),
    detected_to: date | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> dict:
    del user
    filters = {
        "issue_type": issue_type,
        "status": status,
        "severity": severity,
        "detected_from": detected_from,
        "detected_to": detected_to,
    }
    items = service.list_issues(db, limit=limit, offset=offset, **filters)
    # total 必须是「满足条件的总数」，不能是当前页条数，否则前端分页器会失真。
    return {"items": items, "total": service.count_issues(db, **filters)}


@router.get("/quality/issues/{issue_id}")
def issue_detail(
    issue_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = Depends(get_current_user),
    _ok: CurrentUser = read_access,
) -> dict:
    del user
    return service.get_issue(db, issue_id)


@router.post("/quality/issues/{issue_id}/assign")
def assign_issue(
    issue_id: int,
    payload: dict,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = Depends(get_current_user),
    _ok: CurrentUser = resolve_access,
) -> dict:
    owner_id = payload.get("owner_id")
    if owner_id is None:
        from app.core.errors import Validation

        raise Validation("缺少 owner_id", details={"field": "owner_id"})
    return service.assign_issue(db, issue_id, int(owner_id), actor=user.username)


@router.post("/quality/issues/{issue_id}/resolve")
def resolve_issue(
    issue_id: int,
    payload: dict,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = Depends(get_current_user),
    _ok: CurrentUser = resolve_access,
) -> dict:
    return service.resolve_issue(
        db,
        issue_id,
        resolution=payload.get("resolution", ""),
        actor=user.username,
        close=bool(payload.get("close", True)),
    )


@router.post("/quality/issues/{issue_id}/ignore")
def ignore_issue(
    issue_id: int,
    payload: dict,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = Depends(get_current_user),
    _ok: CurrentUser = resolve_access,
) -> dict:
    return service.ignore_issue(
        db, issue_id, reason=payload.get("reason", ""), actor=user.username
    )


__all__ = ["router"]
