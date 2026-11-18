"""导入批次：提交、映射预览与对账报告。"""
from __future__ import annotations
from decimal import Decimal
from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.time import now_second
from app.domain.enums import AuditAction, ImportBatchStatus, ImportRowStatus
from app.domain.imports import ImportBatch, ImportRow
from app.imports._shared import _batch_out, _raw_amount_sum

def commit_batch(session: Session, batch_id: int, *, actor: str = "system") -> dict[str, Any]:
    """提交批次：已映射行标记 IMPORTED；未映射行生成导入异常（不阻塞）。

    这里**不写任何业务数据**——导入行只作为参考记录与回归样本。
    """
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFound(f"导入批次 {batch_id} 不存在", details={"batch_id": batch_id})
    if batch.status == ImportBatchStatus.COMMITTED.value:
        raise Validation("批次已提交，不可重复提交", details={"batch_id": batch_id})
    if batch.status not in {
        ImportBatchStatus.DRAFT.value,
        ImportBatchStatus.MAPPED.value,
    }:
        raise Validation(
            "只有未确认批次可提交",
            details={"batch_id": batch_id, "status": batch.status},
        )

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
            row.issue_note = row.issue_note or f"导入行未映射：{batch.source_name} 第 {row.row_no} 行"

    batch.status = ImportBatchStatus.COMMITTED.value
    batch.committed_at = now_second()
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


def reconciliation_report(session: Session, batch_id: int) -> dict[str, Any]:
    """MIG-01-04：导入前后对账（行数 / 金额 / 池余额 / 损益 / 权益）。

    关键约束：导入**不写任何业务数据**，所以「导入后」侧的
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

    # 导入模块没有业务流水外键，也不写 order_event/cashflow；
    # 不能用全库备注文本推断本批次是否写入资金，否则会把无关订单误报为本批次结果。
    linked_flows = 0

    diff_rows = len(rows) - len(imported) - len(skipped)
    return {
        "batch_id": batch_id,
        "batch_no": batch.batch_no,
        "source_name": batch.source_name,
        "status": batch.status,
        "generated_at": now_second().isoformat(),
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
            "linked_event_cashflow": linked_flows,
            "note": "导入不写任何现金流，池余额/损益/权益导入前后必须一致",
        },
        "requires_adjudication": bool(unlinked or unmapped or diff_rows != 0),
    }
