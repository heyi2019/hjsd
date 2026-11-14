"""CORE-01 批次六 数据与基础设施回归（#26 / #27 / #30）。

#26 导出限流：主列表导出统一受 EXPORT_ROW_LIMIT 约束，查询层不再 limit=None 全量拉库；
#27 编号器幂等：ensure_sequence 并发冲突不 500，且幂等返回既有行、不覆盖既有配置；
注：#29 客户判重按 owner 隔离属既定隐私设计（IT-C01-046 测试锁定，
管理员 owner_scope=ALL 时本就全库判重），不在本批修改。
"""
from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.core import numbering
from app.domain.foundation import AuditLog, DocumentSequence
from app.lists import export as export_module
from app.lists.export import EXPORT_ROW_LIMIT, build_list_csv


# ---------------------------------------------------------------- #26 导出限流
def test_export_row_limit_contract_is_10000():
    assert EXPORT_ROW_LIMIT == 10_000


def test_build_list_csv_truncates_when_over_limit(seeded_db, monkeypatch):
    """拼装层兜底：即便调用方交来超量行，写出也截到上限并标注 truncated。"""
    monkeypatch.setattr(export_module, "EXPORT_ROW_LIMIT", 3)
    rows = [{"row_type": "明细", "title": f"第{i}行"} for i in range(5)]
    csv_text, meta = build_list_csv(seeded_db, "CUSTOMER", rows)
    assert meta["row_count"] == 3
    assert meta["truncated"] is True
    lines = [line for line in csv_text.splitlines() if line.strip()]
    assert len(lines) - 1 == 3  # 去掉单行表头


def test_build_list_csv_under_limit_not_truncated(seeded_db):
    rows = [{"row_type": "明细", "title": "甲"}, {"row_type": "明细", "title": "乙"}]
    _csv_text, meta = build_list_csv(seeded_db, "CUSTOMER", rows)
    assert meta["row_count"] == 2
    assert meta["truncated"] is False


def test_stocks_export_passes_export_row_limit(seeded_client, headers, monkeypatch):
    """库存导出查询层传 EXPORT_ROW_LIMIT，不再 limit=None 拉全量。"""
    from app.stocks.inventory import list_accounts

    seen: dict[str, object] = {}
    original = list_accounts

    def spy(db, **kwargs):
        seen.update(kwargs)
        return original(db, **kwargs)

    monkeypatch.setattr("app.stocks.router.stocks_list_accounts", spy)
    resp = seeded_client.get("/api/v1/stocks/export.csv", headers=headers)
    assert resp.status_code == 200, resp.text
    assert seen.get("limit") == EXPORT_ROW_LIMIT


def test_customers_export_passes_export_row_limit(seeded_client, headers, monkeypatch):
    """客户导出查询层传 EXPORT_ROW_LIMIT，不再 limit=None 拉全量。"""
    from app.parties.customers import list_customers

    seen: dict[str, object] = {}
    original = list_customers

    def spy(db, **kwargs):
        seen.update(kwargs)
        return original(db, **kwargs)

    monkeypatch.setattr("app.parties.router.parties_list_customers", spy)
    resp = seeded_client.get("/api/v1/customers/export.csv", headers=headers)
    assert resp.status_code == 200, resp.text
    assert seen.get("limit") == EXPORT_ROW_LIMIT


def test_stocks_export_audit_records_row_count_and_truncated(
    seeded_client, headers, seeded_db
):
    seeded_client.get("/api/v1/stocks/export.csv", headers=headers)
    audit = seeded_db.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "list_export",
            AuditLog.entity_id == "INVENTORY",
        )
        .order_by(AuditLog.id.desc())
    ).first()
    assert audit is not None
    after = audit.after_json or {}
    assert "rows" in after
    assert after["truncated"] is False


# ---------------------------------------------------------------- #27 编号器幂等
def test_ensure_sequence_idempotent_single_row(seeded_db):
    first = numbering.ensure_sequence(seeded_db, "B6_SEQ_IDEM", "B6", padding=5)
    second = numbering.ensure_sequence(seeded_db, "B6_SEQ_IDEM", "B6", padding=5)
    assert second.id == first.id
    count = seeded_db.scalar(
        select(func.count())
        .select_from(DocumentSequence)
        .where(DocumentSequence.sequence_key == "B6_SEQ_IDEM")
    )
    assert count == 1


def test_ensure_sequence_conflict_keeps_existing_config(seeded_db):
    """预置同 key 行模拟并发已落库：走 ON CONFLICT 分支，不覆盖既有配置。"""
    existing = DocumentSequence(
        sequence_key="B6_SEQ_CONFLICT", prefix="EX", padding=6, current_value=7
    )
    seeded_db.add(existing)
    seeded_db.flush()
    got = numbering.ensure_sequence(seeded_db, "B6_SEQ_CONFLICT", "ZZ", padding=4)
    assert got.id == existing.id
    assert (got.prefix, got.padding, got.current_value) == ("EX", 6, 7)
    count = seeded_db.scalar(
        select(func.count())
        .select_from(DocumentSequence)
        .where(DocumentSequence.sequence_key == "B6_SEQ_CONFLICT")
    )
    assert count == 1


def test_allocate_number_after_ensure_sequence(seeded_db):
    numbering.ensure_sequence(seeded_db, "B6_SEQ_ALLOC", "BA", padding=4)
    assert numbering.allocate_number(seeded_db, "B6_SEQ_ALLOC") == "BA0001"
    assert numbering.allocate_number(seeded_db, "B6_SEQ_ALLOC") == "BA0002"


# ---------------------------------------------------------------- #26 延伸：分期导出参数透传
def test_installments_export_all_query_params_explicitly_none(seeded_client, headers):
    """分期导出直接调用列表路由函数：每个 Query(default=None) 参数都须显式传 None。

    此前漏传 contract_type，Query(None) 对象被透传进 SQL 触发 psycopg 适配 500。
    本用例锁定「无筛选导出应正常返回」契约。
    """
    resp = seeded_client.get("/api/v1/installments/export.csv", headers=headers)
    assert resp.status_code == 200, resp.text
