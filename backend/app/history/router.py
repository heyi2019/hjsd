"""history.router：P2 历史参考导入（MIG-01，只读参考 + 人工映射）。"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_HISTORY_IMPORT,
    CurrentUser,
    get_current_user,
    require_permissions,
)
from app.history import service

router = APIRouter(tags=["history"])
import_access = require_permissions(PERM_HISTORY_IMPORT)


@router.post("/history/batches")
def create_batch(
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """上传历史原始行。系统不做任何自动匹配。"""
    return service.create_batch(
        db,
        source_name=payload.get("source_name", ""),
        rows=payload.get("rows", []),
        source_kind=payload.get("source_kind", "LEGACY_ORDER"),
        actor=user.username,
        note=payload.get("note"),
    )


@router.get("/history/batches")
def list_batches(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    items = service.list_batches(db)
    return {"items": items, "total": len(items)}


@router.get("/history/batches/{batch_id}/rows")
def list_rows(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
    status: str | None = Query(default=None),
) -> dict[str, Any]:
    items = service.list_rows(db, batch_id, status=status)
    return {"items": items, "total": len(items)}


@router.post("/history/rows/{row_id}/map")
def assign_mapping(
    row_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """人工指派映射（禁止自动匹配，接口不提供任何候选推断）。"""
    return service.assign_mapping(
        db,
        row_id,
        order_id=payload.get("order_id"),
        account_id=payload.get("account_id"),
        basis=payload.get("basis", ""),
        actor=user.username,
    )


@router.post("/history/rows/{row_id}/skip")
def skip_row(
    row_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    return service.skip_row(db, row_id, reason=payload.get("reason", ""), actor=user.username)


@router.post("/history/batches/{batch_id}/commit")
def commit_batch(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """提交批次：未映射行转异常工单；不写任何业务数据。"""
    return service.commit_batch(db, batch_id, actor=user.username)


@router.get("/history/batches/{batch_id}/preview")
def preview_mapping(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """MIG-01-02 字段映射预览：源列 / 目标字段 / 样例 / 异常数。只读，不落库。"""
    return service.preview_mapping(db, batch_id)


@router.get("/history/batches/{batch_id}/reconciliation")
def reconciliation(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """MIG-01-04 迁移对账报告：行数 / 金额 / 资金侧前后差异。"""
    return service.reconciliation_report(db, batch_id)


@router.post("/history/rows/{row_id}/unlinked-transfer")
def mark_unlinked(
    row_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """MIG-01-06 标记历史单边划转未裁决。只打标记 + 开工单，绝不补造配对流水。"""
    return service.mark_unlinked_transfer(
        db, row_id, note=payload.get("note"), actor=user.username
    )


@router.post("/history/batches/{batch_id}/rollback")
def rollback_batch(
    batch_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """MIG-01-07 整批逻辑回滚（仅未确认批次；已确认须走更正批次）。"""
    return service.rollback_batch(
        db, batch_id, reason=payload.get("reason", ""), actor=user.username
    )


@router.post("/history/batches/{batch_id}/corrections")
def create_correction(
    batch_id: int,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> dict[str, Any]:
    """MIG-01-08 更正批次：原批次只读，更正以新批次分层保存。"""
    return service.create_correction_batch(
        db,
        batch_id,
        rows=payload.get("rows", []),
        reason=payload.get("reason", ""),
        actor=user.username,
    )


__all__ = ["router"]
