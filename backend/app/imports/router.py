"""imports.router：标准导入（MIG-01，只读原始行 + 人工映射）。"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_IMPORT_MANAGE,
    CurrentUser,
    require_permissions,
)
from app.imports import schemas, service

router = APIRouter(tags=["imports"])
import_access = require_permissions(PERM_IMPORT_MANAGE)


@router.post("/imports/batches", response_model=schemas.ImportBatchOut)
def create_batch(
    payload: schemas.ImportBatchCreate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportBatchOut:
    """上传标准原始行。系统不做任何自动匹配。"""
    return schemas.ImportBatchOut.model_validate(
        service.create_batch(
            db,
            source_name=payload.source_name,
            rows=payload.rows,
            source_kind=payload.source_kind,
            actor=user.username,
            note=payload.note,
        )
    )


@router.get("/imports/batches", response_model=schemas.ImportBatchListOut)
def list_batches(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportBatchListOut:
    items = service.list_batches(db)
    return schemas.ImportBatchListOut(
        items=[schemas.ImportBatchOut.model_validate(item) for item in items],
        total=len(items),
    )


@router.get("/imports/batches/{batch_id}/rows", response_model=schemas.ImportRowListOut)
def list_rows(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
    status: str | None = Query(default=None),
) -> schemas.ImportRowListOut:
    items = service.list_rows(db, batch_id, status=status)
    return schemas.ImportRowListOut(
        items=[schemas.ImportRowOut.model_validate(item) for item in items],
        total=len(items),
    )


@router.post("/imports/rows/{row_id}/map", response_model=schemas.ImportRowOut)
def assign_mapping(
    row_id: int,
    payload: schemas.ImportRowMapping,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportRowOut:
    """人工指派映射（禁止自动匹配，接口不提供任何候选推断）。"""
    return schemas.ImportRowOut.model_validate(
        service.assign_mapping(
            db,
            row_id,
            order_id=payload.order_id,
            account_id=payload.account_id,
            basis=payload.basis,
            actor=user.username,
        )
    )


@router.post("/imports/rows/{row_id}/skip", response_model=schemas.ImportRowOut)
def skip_row(
    row_id: int,
    payload: schemas.ImportRowSkip,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportRowOut:
    return schemas.ImportRowOut.model_validate(
        service.skip_row(db, row_id, reason=payload.reason, actor=user.username)
    )


@router.post("/imports/batches/{batch_id}/commit", response_model=schemas.ImportCommitOut)
def commit_batch(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportCommitOut:
    """提交批次：未映射行转异常工单；不写任何业务数据。"""
    return schemas.ImportCommitOut.model_validate(
        service.commit_batch(db, batch_id, actor=user.username)
    )


@router.get("/imports/batches/{batch_id}/preview", response_model=schemas.ImportPreviewOut)
def preview_mapping(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportPreviewOut:
    """MIG-01-02 字段映射预览：源列 / 目标字段 / 样例 / 异常数。只读，不落库。"""
    return schemas.ImportPreviewOut.model_validate(service.preview_mapping(db, batch_id))


@router.get(
    "/imports/batches/{batch_id}/reconciliation",
    response_model=schemas.ImportReconciliationOut,
)
def reconciliation(
    batch_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportReconciliationOut:
    """MIG-01-04 导入对账报告：行数 / 金额 / 资金侧前后差异。"""
    return schemas.ImportReconciliationOut.model_validate(
        service.reconciliation_report(db, batch_id)
    )


@router.post(
    "/imports/rows/{row_id}/unlinked-transfer",
    response_model=schemas.ImportRowOut,
)
def mark_unlinked(
    row_id: int,
    payload: schemas.ImportRowUnlinkedTransfer,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportRowOut:
    """MIG-01-06 标记单边划转未裁决。只打标记 + 开工单，绝不补造配对流水。"""
    return schemas.ImportRowOut.model_validate(
        service.mark_unlinked_transfer(
            db, row_id, note=payload.note, actor=user.username
        )
    )


@router.post(
    "/imports/batches/{batch_id}/rollback",
    response_model=schemas.ImportRollbackOut,
)
def rollback_batch(
    batch_id: int,
    payload: schemas.ImportBatchRollback,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportRollbackOut:
    """MIG-01-07 整批逻辑回滚（仅未确认批次；已确认须走更正批次）。"""
    return schemas.ImportRollbackOut.model_validate(
        service.rollback_batch(
            db, batch_id, reason=payload.reason, actor=user.username
        )
    )


@router.post(
    "/imports/batches/{batch_id}/corrections",
    response_model=schemas.ImportCorrectionOut,
)
def create_correction(
    batch_id: int,
    payload: schemas.ImportCorrectionCreate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = import_access,
) -> schemas.ImportCorrectionOut:
    """MIG-01-08 更正批次：原批次只读，更正以新批次分层保存。"""
    return schemas.ImportCorrectionOut.model_validate(
        service.create_correction_batch(
            db,
            batch_id,
            rows=payload.rows,
            reason=payload.reason,
            actor=user.username,
        )
    )


__all__ = ["router"]
