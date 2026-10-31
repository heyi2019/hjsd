"""imports 批次生命周期：创建、列表、未关联划转、回滚、更正与驳回。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.time import now_second
from app.core.numbering import allocate_number
from app.domain.enums import (
    AuditAction,
    ImportBatchStatus,
    ImportRowStatus,
    ImportSourceKind,
    SequenceKey,
)
from app.domain.imports import ImportBatch, ImportRow

from ._shared import (
    _required_text,
    _assert_batch_editable,
    _batch_out,
    _row_out,
)

def create_batch(
    session: Session,
    *,
    source_name: str,
    rows: list[dict[str, Any]],
    source_kind: str = ImportSourceKind.ORDER.value,
    actor: str = "system",
    note: str | None = None,
) -> dict[str, Any]:
    """落原始行。只保存原文，不做任何字段推断或匹配。"""
    name = _required_text(
        source_name, field="source_name", message="source_name 不能为空"
    )
    if not rows:
        raise Validation("导入内容为空", details={"field": "rows"})
    invalid_rows = [index for index, raw in enumerate(rows, start=1) if not isinstance(raw, dict)]
    if invalid_rows:
        raise Validation(
            "每行必须为对象",
            details={"field": "rows", "invalid_rows": invalid_rows},
        )
    try:
        source_kind = ImportSourceKind(source_kind).value
    except ValueError as exc:
        raise Validation(
            f"source_kind 必须为 {ImportSourceKind.values()}",
            details={"field": "source_kind", "value": source_kind},
        ) from exc

    batch = ImportBatch(
        batch_no=allocate_number(session, SequenceKey.IMPORT.value),
        source_name=name,
        source_kind=source_kind,
        status=ImportBatchStatus.DRAFT.value,
        row_count=len(rows),
        unmapped_count=len(rows),
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(batch)
    session.flush()
    for index, raw in enumerate(rows, start=1):
        session.add(
            ImportRow(
                batch_id=batch.id,
                row_no=index,
                raw=raw,
                status=ImportRowStatus.UNMAPPED.value,
            )
        )
    session.flush()
    record_audit(
        session,
        action=AuditAction.IMPORT_LAND,
        entity_type="import_batch",
        entity_id=batch.id,
        actor=actor,
        after={"batch_no": batch.batch_no, "row_count": len(rows), "source_name": name},
    )
    return _batch_out(batch)


def list_batches(session: Session) -> list[dict[str, Any]]:
    rows = session.scalars(
        select(ImportBatch).order_by(ImportBatch.id.desc())
    ).all()
    return [_batch_out(row) for row in rows]


def mark_unlinked_transfer(
    session: Session,
    row_id: int,
    *,
    actor: str = "system",
    note: str | None = None,
) -> dict[str, Any]:
    """MIG-01-06：标记「单边划转未裁决」。

    红线：只打标记 + 留痕，**绝不生成配对流水**。Q14 类未裁决记录
    必须在系统里可见（row.issue_note），但不得凭空补出对手方。
    """
    row = session.get(ImportRow, row_id)
    if row is None:
        raise NotFound(f"导入行 {row_id} 不存在", details={"row_id": row_id})
    if row.unlinked_transfer:
        return _row_out(row)
    _assert_batch_editable(session, row.batch_id)

    before = {"unlinked_transfer": False, "issue_note": row.issue_note}
    row.unlinked_transfer = True
    row.issue_note = note or row.issue_note or "单边划转未裁决：已标记，不自动配对"
    session.flush()

    record_audit(
        session,
        action=AuditAction.IMPORT_MARK_UNLINKED,
        entity_type="import_row",
        entity_id=row.id,
        actor=actor,
        before=before,
        after={"unlinked_transfer": True, "note": row.issue_note},
    )
    return _row_out(row)


def rollback_batch(
    session: Session, batch_id: int, *, reason: str, actor: str = "system"
) -> dict[str, Any]:
    """MIG-01-07：整批逻辑回滚。

    规则：
    1. 只有**未确认**（DRAFT/MAPPED）批次可整批回滚；
    2. 已确认（COMMITTED）批次拒绝回滚，只能走 create_correction_batch；
    3. 回滚**不删除**原始文件与审计日志，只改状态。
    """
    text = _required_text(reason, field="reason", message="回滚必须填写理由")
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    if batch.status == ImportBatchStatus.ROLLED_BACK.value:
        raise Validation("批次已回滚，不可重复操作", details={"batch_id": batch_id})
    if batch.status == ImportBatchStatus.COMMITTED.value:
        raise Validation(
            "已确认批次不可回滚，请改用更正批次（MIG-01-08）",
            details={"batch_id": batch_id, "status": batch.status},
        )
    if batch.status not in {
        ImportBatchStatus.DRAFT.value,
        ImportBatchStatus.MAPPED.value,
    }:
        raise Validation(
            "只有未确认批次可回滚",
            details={"batch_id": batch_id, "status": batch.status},
        )

    before = {"status": batch.status}
    rows = session.scalars(select(ImportRow).where(ImportRow.batch_id == batch_id)).all()
    for row in rows:
        if row.status != ImportRowStatus.IMPORTED.value:
            row.status = ImportRowStatus.ROLLED_BACK.value
    batch.status = ImportBatchStatus.ROLLED_BACK.value
    batch.rolled_back_at = now_second()
    batch.rolled_back_by = actor
    batch.rollback_reason = text
    batch.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.IMPORT_ROLLBACK,
        entity_type="import_batch",
        entity_id=batch.id,
        actor=actor,
        before=before,
        after={"status": batch.status, "rows": len(rows), "reason": text},
    )
    return {**_batch_out(batch), "rolled_back_rows": len(rows)}


def create_correction_batch(
    session: Session,
    batch_id: int,
    *,
    rows: list[dict[str, Any]],
    reason: str,
    actor: str = "system",
) -> dict[str, Any]:
    """MIG-01-08：已确认批次的冲销/更正批次。

    原批次与原始行**一律不动**（只读保护），更正以新批次分层保存，
    通过 corrects_batch_id 指回原批次，形成可追溯的更正链。
    """
    text = _required_text(
        reason, field="reason", message="更正批次必须填写理由"
    )
    origin = session.get(ImportBatch, batch_id)
    if origin is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    if origin.status != ImportBatchStatus.COMMITTED.value:
        raise Validation(
            "只有已提交批次可更正",
            details={"batch_id": batch_id, "status": origin.status},
        )
    if not rows:
        raise Validation("更正内容为空", details={"field": "rows"})
    invalid_rows = [index for index, raw in enumerate(rows, start=1) if not isinstance(raw, dict)]
    if invalid_rows:
        raise Validation(
            "每行必须为对象",
            details={"field": "rows", "invalid_rows": invalid_rows},
        )

    origin.status = ImportBatchStatus.CORRECTED.value
    origin.updated_by = actor
    new_batch = ImportBatch(
        batch_no=allocate_number(session, SequenceKey.IMPORT.value),
        source_name=origin.source_name,
        source_kind=origin.source_kind,
        status=ImportBatchStatus.DRAFT.value,
        row_count=len(rows),
        unmapped_count=len(rows),
        corrects_batch_id=origin.id,
        note=f"更正批次：{text}",
        created_by=actor,
        updated_by=actor,
    )
    session.add(new_batch)
    session.flush()
    for index, raw in enumerate(rows, start=1):
        session.add(
            ImportRow(
                batch_id=new_batch.id,
                row_no=index,
                raw=raw,
                status=ImportRowStatus.UNMAPPED.value,
            )
        )
    session.flush()
    record_audit(
        session,
        action=AuditAction.IMPORT_CORRECTION,
        entity_type="import_batch",
        entity_id=new_batch.id,
        actor=actor,
        before={"origin_status": ImportBatchStatus.COMMITTED.value, "origin_id": origin.id},
        after={"corrects_batch_id": origin.id, "rows": len(rows), "reason": text},
    )
    return {**_batch_out(new_batch), "corrects_batch_no": origin.batch_no}


def reject_batch(
    session: Session, batch_id: int, *, reason: str, actor: str = "system"
) -> dict[str, Any]:
    """整批驳回（REJECTED，终态）：审核判定该批数据不进系统。

    规则：只有未确认（DRAFT/MAPPED）批次可驳回；已确认走
    rollback_batch / create_correction_batch。驳回不删原始文件与审计，
    行状态一律不动（原始行是留档事实）。
    """
    text = _required_text(reason, field="reason", message="驳回必须填写理由")
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    if batch.status in {
        ImportBatchStatus.REJECTED.value,
        ImportBatchStatus.ROLLED_BACK.value,
        ImportBatchStatus.CORRECTED.value,
    }:
        raise Validation(
            "批次已终态，不可重复驳回",
            details={"batch_id": batch_id, "status": batch.status},
        )
    if batch.status == ImportBatchStatus.COMMITTED.value:
        raise Validation(
            "已确认批次不可驳回，请改用回滚或更正批次（MIG-01-07/08）",
            details={"batch_id": batch_id, "status": batch.status},
        )
    before = {"status": batch.status}
    batch.status = ImportBatchStatus.REJECTED.value
    batch.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.IMPORT_REJECT,
        entity_type="import_batch",
        entity_id=batch.id,
        actor=actor,
        before=before,
        after={"status": batch.status, "reason": text},
        reason=text,
    )
    return _batch_out(batch)
