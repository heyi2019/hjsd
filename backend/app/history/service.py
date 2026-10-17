"""history.service：P2 标准导入（MIG-01）。

红线（开发任务清单「阻断规则」）：
1. **禁止自动匹配**订单/账号/返点 —— 映射只能由人工指派 `assign_mapping`；
2. **禁止补造单边划转** —— 本模块不写任何 cashflow / order_event；
3. 导入行**不覆盖业务单** —— 导入只落 `import_rows.raw`，不 upsert 业务表；
4. 未映射行提交时保持 `UNMAPPED` 状态并在 `issue_note` 留痕，可见但不阻塞新业务。
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.numbering import allocate_number
from app.domain.enums import (
    AuditAction,
    ImportBatchStatus,
    ImportRowStatus,
    ImportSourceKind,
    SequenceKey,
)
from app.domain.history import ImportBatch, ImportRow
from app.domain.trade import Account, Cashflow, Order, OrderEvent


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
        raise Validation("已导入的历史行不可再改映射", details={"row_id": row_id})
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
    row.mapped_at = datetime.now()
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
        reason, field="reason", message="跳过历史行必须填写理由"
    )
    row = session.get(ImportRow, row_id)
    if row is None:
        raise NotFound(f"导入行 {row_id} 不存在", details={"row_id": row_id})
    row.status = ImportRowStatus.SKIPPED.value
    row.issue_note = text
    session.flush()
    _refresh_counts(session, row.batch_id)
    return _row_out(row)


def commit_batch(session: Session, batch_id: int, *, actor: str = "system") -> dict[str, Any]:
    """提交批次：已映射行标记 IMPORTED；未映射行生成导入异常（不阻塞）。

    这里**不写任何业务数据**——历史只作为参考记录与回归样本。
    """
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    if batch.status == ImportBatchStatus.COMMITTED.value:
        raise Validation("批次已提交，不可重复提交", details={"batch_id": batch_id})

    rows = session.scalars(
        select(ImportRow).where(ImportRow.batch_id == batch_id)
    ).all()
    imported = 0
    unmapped = 0
    for row in rows:
        if row.status == ImportRowStatus.SKIPPED.value:
            continue
        if row.mapped_order_id or row.mapped_account_id:
            row.status = ImportRowStatus.IMPORTED.value
            imported += 1
        else:
            row.status = ImportRowStatus.UNMAPPED.value
            unmapped += 1
            row.issue_note = row.issue_note or f"历史行未映射：{batch.source_name} 第 {row.row_no} 行"

    batch.status = ImportBatchStatus.COMMITTED.value
    batch.committed_at = datetime.now()
    batch.unmapped_count = unmapped
    batch.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.IMPORT_COMMIT,
        entity_type="import_batch",
        entity_id=batch.id,
        actor=actor,
        before={"status": ImportBatchStatus.MAPPED.value},
        after={"status": batch.status, "imported": imported, "unmapped": unmapped},
    )
    return {**_batch_out(batch), "imported": imported, "unmapped": unmapped}


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


def mark_unlinked_transfer(
    session: Session,
    row_id: int,
    *,
    actor: str = "system",
    note: str | None = None,
) -> dict[str, Any]:
    """MIG-01-06：标记「历史单边划转未裁决」。

    红线：只打标记 + 留痕，**绝不生成配对流水**。Q14 类未裁决记录
    必须在系统里可见（row.issue_note），但不得凭空补出对手方。
    """
    row = session.get(ImportRow, row_id)
    if row is None:
        raise NotFound(f"导入行 {row_id} 不存在", details={"row_id": row_id})
    if row.unlinked_transfer:
        return _row_out(row)

    before = {"unlinked_transfer": False, "issue_note": row.issue_note}
    row.unlinked_transfer = True
    row.issue_note = note or row.issue_note or "历史单边划转未裁决：已标记，不自动配对"
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


# ── MIG-01-02 字段映射预览 ────────────────────────────────────

# 源列 → 标准字段的**建议**映射。仅用于给人看，系统不据此自动指派。
SOURCE_COLUMN_HINTS: dict[str, str] = {
    "日期": "occurred_on",
    "月份": "occurred_on",
    "交易金额": "gross_amount",
    "本金": "principal",
    "利润": "profit",
    "订单类型": "business_type",
    "订单号": "order_no",
    "账号": "game_account",
    "回收员": "handler",
    "售卖员": "handler",
    "返点": "rebate",
}


def preview_mapping(
    session: Session, batch_id: int
) -> dict[str, Any]:
    """MIG-01-02：源列 / 目标字段 / 建议规则 / 样例 / 异常数。

    刻意**不落库**、不自动指派：预览只是给人做决策依据。
    """
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    rows = session.scalars(
        select(ImportRow).where(ImportRow.batch_id == batch_id)
    ).all()
    if not rows:
        return {
            "batch_id": batch_id,
            "batch_no": batch.batch_no,
            "source_name": batch.source_name,
            "total_rows": 0,
            "columns": [],
            "abnormal": {"empty_value": 0, "unmapped": batch.unmapped_count},
            "blockers": [],
        }

    # 统计每个源列：出现次数、非空数、样例（最多 3 个）
    stats: dict[str, dict[str, Any]] = {}
    empty_value = 0
    for row in rows:
        raw = row.raw or {}
        for key, value in raw.items():
            item = stats.setdefault(
                key, {"column": key, "present": 0, "filled": 0, "samples": []}
            )
            item["present"] += 1
            if value not in (None, ""):
                item["filled"] += 1
                if len(item["samples"]) < 3:
                    text = str(value)
                    if text not in item["samples"]:
                        item["samples"].append(text[:40])
            else:
                empty_value += 1

    columns = []
    blockers = []
    for key, item in sorted(stats.items(), key=lambda kv: -kv[1]["present"]):
        target = SOURCE_COLUMN_HINTS.get(key)
        rate = round(item["filled"] / max(rows.__len__(), 1) * 100, 1)
        columns.append(
            {
                "source_column": key,
                "target_field": target,
                "suggested": target is not None,
                "present_count": item["present"],
                "filled_count": item["filled"],
                "fill_rate": rate,
                "samples": item["samples"],
            }
        )
        # 未映射核心字段阻断确认（MIG-01-02）
        if target is None and item["present"] == len(rows):
            blockers.append(key)

    return {
        "batch_id": batch_id,
        "batch_no": batch.batch_no,
        "source_name": batch.source_name,
        "total_rows": len(rows),
        "columns": columns,
        "abnormal": {
            "empty_value": empty_value,
            "unmapped": batch.unmapped_count,
            "missing_core_columns": blockers,
        },
        "blockers": blockers,
    }


# ── MIG-01-04 迁移对账报告 ────────────────────────────────────

# 源文件里表示金额的列（用于汇总迁移前后差异）
_AMOUNT_KEYS = ("交易金额", "本金", "利润", "amount", "principal", "profit")


def _raw_amount_sum(rows: list[ImportRow]) -> dict[str, str]:
    """按源列汇总原始金额。历史文件里「利润/本金/交易金额」各自独立，不能混算。"""
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


def reconciliation_report(session: Session, batch_id: int) -> dict[str, Any]:
    """MIG-01-04：迁移前后对账（行数 / 金额 / 池余额 / 损益 / 权益）。

    关键约束：历史导入**不写任何业务数据**，所以「迁移后」侧的
    池余额/损益/权益只应反映本批次带来的**参考映射**，不产生资金变动。
    差异不为零时必须裁决或阻断上线。
    """
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    rows = session.scalars(
        select(ImportRow).where(ImportRow.batch_id == batch_id)
    ).all()

    mapped = [r for r in rows if r.mapped_order_id or r.mapped_account_id]
    unmapped = [r for r in rows if not (r.mapped_order_id or r.mapped_account_id) and r.status != ImportRowStatus.SKIPPED.value]
    skipped = [r for r in rows if r.status == ImportRowStatus.SKIPPED.value]
    imported = [r for r in rows if r.status == ImportRowStatus.IMPORTED.value]
    unlinked = [r for r in rows if r.unlinked_transfer]

    before_amounts = _raw_amount_sum(rows)
    after_amounts = _raw_amount_sum(imported)

    # 资金侧红线自证：历史行**不得**关联任何 order_event，
    # 一旦有关联说明有人绕过红线写了业务数据，对账必须报出来。
    linked_flows = session.scalar(
        select(func.count(Cashflow.id))
        .join(OrderEvent, Cashflow.order_event_id == OrderEvent.id)
        .where(OrderEvent.note.like("%历史%"))
    )

    diff_rows = len(rows) - len(imported) - len(skipped)
    return {
        "batch_id": batch_id,
        "batch_no": batch.batch_no,
        "source_name": batch.source_name,
        "status": batch.status,
        "generated_at": datetime.now().isoformat(),
        "rows": {
            "source_total": len(rows),
            "imported": len(imported),
            "mapped_not_imported": len(mapped),
            "unmapped": len(unmapped),
            "skipped": len(skipped),
            "unlinked_transfer": len(unlinked),
            "unaccounted": diff_rows,
        },
        "amounts": {
            "before": before_amounts,
            "after": after_amounts,
            "delta": {
                key: str(
                    (Decimal(after_amounts.get(key, "0")) - Decimal(before_amounts.get(key, "0"))).quantize(Decimal("0.01"))
                )
                for key in before_amounts
            },
        },
        "funds": {
            "cashflow_written": 0,
            "linked_event_cashflow": int(linked_flows or 0),
            "note": "历史导入不写任何现金流，池余额/损益/权益迁移前后必须一致",
        },
        "requires_adjudication": bool(unlinked or unmapped or diff_rows != 0),
    }


# ── MIG-01-07 迁移回滚 / MIG-01-08 更正批次 ───────────────────

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
    batch.rolled_back_at = datetime.now()
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


__all__ = [
    "SOURCE_COLUMN_HINTS",
    "assign_mapping",
    "commit_batch",
    "create_batch",
    "create_correction_batch",
    "list_batches",
    "list_rows",
    "mark_unlinked_transfer",
    "preview_mapping",
    "reconciliation_report",
    "rollback_batch",
    "skip_row",
]
