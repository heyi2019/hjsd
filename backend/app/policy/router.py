"""policy.router：经营规则配置与订单利润分配（T19 / T20）。"""
from __future__ import annotations

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_ORDER_CREATE,
    PERM_POLICY_APPROVE,
    PERM_POLICY_MANAGE,
    CurrentUser,
    require_permissions,
)
from app.policy import service

router = APIRouter(tags=["policy"])
manage_access = require_permissions(PERM_POLICY_MANAGE)
approve_access = require_permissions(PERM_POLICY_APPROVE)
# 注意：require_permissions 返回的已是 Depends 对象，直接作默认值，不要再包一层。
# 只读复用 order.create 门控：项目未定义 order.read，保持既有权限惯例。
read_access = require_permissions(PERM_ORDER_CREATE)


# ── T19 / BAS-06-01：规则定义 ───────────────────────────────────

@router.get("/policies")
def list_definitions(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    status: str | None = Query(default=None),
    policy_code: str | None = Query(default=None),
) -> dict[str, Any]:
    """规则列表：按规则、范围、版本、生效期管理（BAS-06-01）。"""
    items = service.list_definitions(db, status=status, policy_code=policy_code)
    return {"items": items, "total": len(items)}


@router.post("/policies")
def create_definition(
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> dict[str, Any]:
    return service.create_definition(
        db,
        policy_code=payload.get("policy_code", ""),
        name=payload.get("name", ""),
        scope_type=payload.get("scope_type", "GLOBAL"),
        scope_id=payload.get("scope_id"),
        description=payload.get("description"),
        actor=user.username,
    )


@router.get("/policies/{definition_id}")
def get_definition(
    definition_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> dict[str, Any]:
    return service.get_definition(db, definition_id)


@router.get("/policies/{definition_id}/versions")
def list_versions(
    definition_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    status: str | None = Query(default=None),
) -> dict[str, Any]:
    items = service.list_versions(db, definition_id, status=status)
    return {"items": items, "total": len(items)}


# ── T19 / BAS-06-02：版本 ───────────────────────────────────────

@router.post("/policies/{definition_id}/versions")
def create_version(
    definition_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> dict[str, Any]:
    """新增规则版本。生效期不得与已有版本重叠（BAS-06-02）。"""
    effective_from: date = date.fromisoformat(str(payload["effective_from"]))
    effective_to_raw = payload.get("effective_to")
    return service.create_version(
        db,
        definition_id,
        effective_from=effective_from,
        effective_to=date.fromisoformat(str(effective_to_raw)) if effective_to_raw else None,
        config=payload.get("config") or {},
        note=payload.get("note"),
        actor=user.username,
    )


@router.patch("/policy-versions/{version_id}")
def update_version(
    version_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> dict[str, Any]:
    """只允许改草稿版本；已发布版本必须新建（BAS-06-02）。"""
    return service.update_version_draft(
        db, version_id, config=payload.get("config") or {}, actor=user.username
    )


@router.post("/policy-versions/{version_id}/approve")
def approve_version(
    version_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = approve_access,
) -> dict[str, Any]:
    """发布规则版本。发布后只影响生效日后的新计算，不重算历史。"""
    approver = payload.get("approver") or user.username
    return service.approve_version(
        db, version_id, approver=approver, note=payload.get("note")
    )


@router.get("/policy-versions/resolve")
def resolve(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    policy_code: str = Query(...),
    on: date = Query(...),
    scope_type: str = Query(default="GLOBAL"),
    scope_id: int | None = Query(default=None),
) -> dict[str, Any]:
    """取某日某作用域生效版本（BAS-06-04 快照固化的依据）。"""
    version = service.resolve_version(
        db,
        policy_code=policy_code,
        on=on,
        scope_type=scope_type,
        scope_id=scope_id,
    )
    from app.policy.service import _ver_out  # noqa: PLC0415

    return {"found": version is not None, "version": _ver_out(version) if version else None}


# ── T20 / BAS-06-03：订单利润分配 ────────────────────────────────

@router.get("/orders/{order_id}/profit-allocations")
def list_allocations(
    order_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> dict[str, Any]:
    items = service.list_allocations(db, order_id, user=user)
    return {"items": items, "total": len(items)}


@router.put("/orders/{order_id}/profit-allocations")
def set_allocations(
    order_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> dict[str, Any]:
    """整单设置利润分配。有效比例合计必须为 100%（BAS-06-03）。"""
    items = service.set_allocations(
        db, order_id, items=payload.get("items") or [], actor=user.username, user=user
    )
    return {"items": items, "total": len(items)}


@router.get("/orders/{order_id}/policy-snapshot")
def order_snapshot(
    order_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> dict[str, Any]:
    """订单实际应用的规则快照（BAS-06-04：可追溯）。"""
    snapshot = service.snapshot_for(db, order_id, user=user)
    return {"found": snapshot is not None, "snapshot": snapshot}


__all__ = ["router"]
