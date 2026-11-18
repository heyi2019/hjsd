"""导入行：列表、人工映射与跳过。"""
from __future__ import annotations
from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.time import now_second
from app.domain.enums import AuditAction, ImportRowStatus
from app.domain.imports import ImportBatch, ImportRow
from app.domain.trade import Account, Order
from app.imports._shared import (
    _required_text, _validate_optional_id, _assert_batch_editable, _row_out, _refresh_counts,
)

def list_rows(
    session: Session, batch_id: int, *, status: str | None = None
) -> list[dict[str, Any]]:
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    stmt = select(ImportRow).where(ImportRow.batch_id == batch_id)
    if status:
        stmt = stmt.where(ImportRow.status == status.upper())
    return [_row_out(row) for row in session.scalars(stmt.order_by(ImportRow.row_no)).all()]


def assign_mapping(
    session: Session,
    row_id: int,
    *,
    order_id: int | None = None,
    account_id: int | None = None,
    basis: str,
    actor: str = "system",
) -> dict[str, Any]:
    """人工指派映射。刻意不做任何模糊匹配：给什么就认什么。

    MIG-01-05：补录必须有依据（basis 必填），并留存映射前后状态，
    报表可重算且能还原补录前是什么。
    """
    row = session.get(ImportRow, row_id)
    if row is None:
        raise NotFound(f"导入行 {row_id} 不存在", details={"row_id": row_id})
    if row.status == ImportRowStatus.IMPORTED.value:
        raise Validation("已导入的导入行不可再改映射", details={"row_id": row_id})
    _assert_batch_editable(session, row.batch_id)
    order_id = _validate_optional_id(order_id, field="订单")
    account_id = _validate_optional_id(account_id, field="账号")
    text_basis = _required_text(
        basis, field="basis", message="补录关联必须填写依据"
    )

    if order_id is not None:
        if session.get(Order, order_id) is None:
            raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    if account_id is not None:
        if session.get(Account, account_id) is None:
            raise NotFound(f"账号 {account_id} 不存在", details={"account_id": account_id})

    before = {
        "mapped_order_id": row.mapped_order_id,
        "mapped_account_id": row.mapped_account_id,
        "status": row.status,
    }
    # 首次指派时留存前态；重复指派保留最初的原始状态，便于回溯
    if row.mapped_before is None:
        row.mapped_before = before
    row.mapped_order_id = order_id
    row.mapped_account_id = account_id
    row.mapped_by = actor
    row.mapped_at = now_second()
    row.mapping_basis = text_basis
    row.status = (
        ImportRowStatus.MAPPED.value
        if (order_id or account_id)
        else ImportRowStatus.UNMAPPED.value
    )
    session.flush()
    _refresh_counts(session, row.batch_id)
    record_audit(
        session,
        action=AuditAction.IMPORT_MAP,
        entity_type="import_row",
        entity_id=row.id,
        actor=actor,
        before=before,
        after={
            "mapped_order_id": order_id,
            "mapped_account_id": account_id,
            "status": row.status,
        },
    )
    return _row_out(row)


def skip_row(
    session: Session, row_id: int, *, reason: str, actor: str = "system"
) -> dict[str, Any]:
    text = _required_text(
        reason, field="reason", message="跳过导入行必须填写理由"
    )
    row = session.get(ImportRow, row_id)
    if row is None:
        raise NotFound(f"导入行 {row_id} 不存在", details={"row_id": row_id})
    if row.status == ImportRowStatus.IMPORTED.value:
        raise Validation(
            "已导入的导入行不可跳过", details={"row_id": row_id}
        )
    if row.status == ImportRowStatus.ROLLED_BACK.value:
        raise Validation(
            "已回滚的导入行不可跳过", details={"row_id": row_id}
        )
    _assert_batch_editable(session, row.batch_id)
    before = {"status": row.status, "issue_note": row.issue_note}
    row.status = ImportRowStatus.SKIPPED.value
    row.issue_note = text
    session.flush()
    _refresh_counts(session, row.batch_id)
    record_audit(
        session,
        action=AuditAction.IMPORT_SKIP,
        entity_type="import_row",
        entity_id=row.id,
        actor=actor,
        before=before,
        after={"status": row.status, "issue_note": row.issue_note},
        reason=text,
    )
    return _row_out(row)
