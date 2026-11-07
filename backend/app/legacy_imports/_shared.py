"""imports 服务共享工具：参数校验、输出序列化与批次可编辑性判定。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, Validation
from app.domain.enums import ImportBatchStatus, ImportRowStatus
from app.legacy_imports.models import ImportBatch, ImportRow

_AMOUNT_KEYS = ("交易金额", "本金", "利润", "amount", "principal", "profit")


def _required_text(value: Any, *, field: str, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation(message, details={"field": field})
    return value.strip()


def _validate_optional_id(value: object, *, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise Validation(
            f"{field} ID 必须为正整数",
            details={"field": field, "value": value},
        )
    return value


def _assert_batch_editable(session: Session, batch_id: int) -> ImportBatch:
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    if batch.status not in {
        ImportBatchStatus.DRAFT.value,
        ImportBatchStatus.MAPPED.value,
    }:
        raise Validation(
            "已确认批次的导入行不可修改，请使用更正批次",
            details={"batch_id": batch.id, "status": batch.status},
        )
    return batch


def _batch_out(batch: ImportBatch) -> dict[str, Any]:
    return {
        "id": batch.id,
        "batch_no": batch.batch_no,
        "source_name": batch.source_name,
        "source_kind": batch.source_kind,
        "status": batch.status,
        "row_count": batch.row_count,
        "unmapped_count": batch.unmapped_count,
        "committed_at": batch.committed_at.isoformat() if batch.committed_at else None,
        "rolled_back_at": batch.rolled_back_at.isoformat() if batch.rolled_back_at else None,
        "rolled_back_by": batch.rolled_back_by,
        "rollback_reason": batch.rollback_reason,
        "corrects_batch_id": batch.corrects_batch_id,
        "note": batch.note,
    }


def _row_out(row: ImportRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "batch_id": row.batch_id,
        "row_no": row.row_no,
        "raw": row.raw,
        "mapped_order_id": row.mapped_order_id,
        "mapped_account_id": row.mapped_account_id,
        "mapped_by": row.mapped_by,
        "mapped_at": row.mapped_at.isoformat() if row.mapped_at else None,
        "mapping_basis": row.mapping_basis,
        "mapped_before": row.mapped_before,
        "status": row.status,
        "unlinked_transfer": row.unlinked_transfer,
        "issue_note": row.issue_note,
    }


def _refresh_counts(session: Session, batch_id: int) -> None:
    unmapped = session.scalar(
        select(func.count(ImportRow.id)).where(
            ImportRow.batch_id == batch_id,
            ImportRow.status == ImportRowStatus.UNMAPPED.value,
        )
    )
    batch = session.get(ImportBatch, batch_id)
    if batch is not None:
        batch.unmapped_count = int(unmapped or 0)
        session.flush()


def _raw_amount_sum(rows: list[ImportRow]) -> dict[str, str]:
    """按源列汇总原始金额。源文件里「利润/本金/交易金额」各自独立，不能混算。"""
    from app.core.money import to_money

    totals: dict[str, Decimal] = {}
    for row in rows:
        raw = row.raw or {}
        for key in _AMOUNT_KEYS:
            if key not in raw:
                continue
            value = raw[key]
            if isinstance(value, list):  # 某些列是数组（如回款账户）
                continue
            try:
                totals[key] = totals.get(key, Decimal("0")) + to_money(str(value))
            except (ValueError, ArithmeticError):
                continue
    return {key: str(value.quantize(Decimal("0.01"))) for key, value in totals.items()}
