"""历史导入的脱敏与「只落原文」红线测试（MIG-01）。

这些用例守护的是 PRD §23 与历史回归锁死项，**不是**覆盖率：
删掉脱敏逻辑，测试必须变红。
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from app.domain.enums import AuditAction, ImportBatchStatus, ImportRowStatus
from app.history import service as history_service


def _load_script():
    """按路径加载 scripts/land_raw_history.py（脚本目录不在包内）。"""
    path = Path(__file__).resolve().parents[2] / "scripts" / "land_raw_history.py"
    spec = importlib.util.spec_from_file_location("land_raw_history", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def lander():
    return _load_script()


class TestRedaction:
    """凭据字段必须在写入前剥离。"""

    def test_sensitive_fields_removed(self, lander):
        assert lander.REDACTED == "[REDACTED]"
        # 覆盖源数据里实际存在的全部凭据/直接身份字段
        assert lander.SENSITIVE_FIELDS == frozenset(
            {"密码", "账号密码", "账密", "绑定手机号", "买家联系方式"}
        )

    def test_non_empty_sensitive_becomes_placeholder(self, lander):
        cleaned, removed = lander._strip_sensitive({"密码": "secret", "本金": 100})
        assert cleaned["密码"] == lander.REDACTED
        assert "密码" in removed
        assert cleaned["本金"] == 100

    def test_empty_sensitive_key_is_dropped_not_blanked(self, lander):
        """值为空则整键丢弃——「字段存在但为空」与「字段不存在」对映射无区别。"""
        cleaned, removed = lander._strip_sensitive({"密码": "", "账密": None, "日期": "2026-01-01"})
        assert "密码" not in cleaned
        assert "账密" not in cleaned
        assert removed == []
        assert cleaned["日期"] == "2026-01-01"

    def test_non_sensitive_untouched(self, lander):
        """脱敏不得误伤业务字段。"""
        fields = {
            "日期": "2026-06-15",
            "订单类型": "回收",
            "本金": 5000,
            "利润": 800,
            "回款账户（本金/利润）": ["利润荷包（利润）"],
        }
        cleaned, removed = lander._strip_sensitive(dict(fields))
        assert cleaned == fields
        assert removed == []


class TestRawPreservation:
    """原始值必须逐字保留，不做归一化。"""

    def test_operating_expense_category_keeps_slash(self, lander):
        """回归锁死项：写成「房租日用」曾导致 ¥11,989.90 漏计。"""
        cleaned, _ = lander._strip_sensitive({"类别": "房租/日用"})
        assert cleaned["类别"] == "房租/日用"
        assert cleaned["类别"] != "房租日用"

    def test_pool_names_kept_verbatim(self, lander):
        cleaned, _ = lander._strip_sensitive(
            {"回款账户（本金/利润）": ["投资款荷包（本金）", "利润荷包（利润）"]}
        )
        assert cleaned["回款账户（本金/利润）"] == ["投资款荷包（本金）", "利润荷包（利润）"]

    def test_source_id_preserved_for_traceback(self, lander, monkeypatch, tmp_path):
        """金山文档行 ID 必须保留，便于回溯原文位置。"""
        payload = {"records": [{"id": "rec_abc", "日期": "2026-01-01", "密码": "x"}]}
        src = tmp_path / "sheet9_orders.json"
        src.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(lander, "SOURCE_DIR", tmp_path)
        rows, _stats = lander._load("sheet9_orders")
        assert rows[0]["_source_id"] == "rec_abc"

    def test_supports_both_nested_and_flat_shapes(self, lander, monkeypatch, tmp_path):
        """源文件随时可能重新导出，两种行结构都要支持。"""
        payload = {
            "records": [
                {"id": "r1", "fields": {"日期": "2026-01-01", "账密": "p"}},
                {"id": "r2", "日期": "2026-01-02", "账密": "q"},
            ]
        }
        src = tmp_path / "sheet17_installments.json"
        src.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(lander, "SOURCE_DIR", tmp_path)
        rows, stats = lander._load("sheet17_installments")
        assert stats["rows"] == 2
        assert [r["日期"] for r in rows] == ["2026-01-01", "2026-01-02"]
        # 两种结构的敏感字段都被脱敏
        assert all(r["账密"] == lander.REDACTED for r in rows)


class TestNoInference:
    """落地只写原文，绝不推断或自动匹配。"""

    def test_create_batch_writes_no_mapping(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db,
            source_name="测试批次",
            rows=[{"日期": "2026-01-01", "本金": 100}],
            actor="pytest",
        )
        assert batch["row_count"] == 1
        assert batch["unmapped_count"] == 1
        assert batch["status"] == ImportBatchStatus.DRAFT.value

        from app.domain.history import ImportRow

        row = seeded_db.query(ImportRow).filter_by(batch_id=batch["id"]).one()
        assert row.status == ImportRowStatus.UNMAPPED.value
        assert row.mapped_order_id is None
        assert row.mapped_account_id is None

    def test_land_audit_uses_dedicated_action(self, seeded_db):
        """导入审计不得借用 EXCEPTION_APPROVE（否则日志被误读为异常审批）。"""
        history_service.create_batch(
            seeded_db,
            source_name="审计动作测试",
            rows=[{"日期": "2026-01-01"}],
            actor="pytest",
        )
        from app.domain.foundation import AuditLog

        logs = (
            seeded_db.query(AuditLog)
            .filter_by(entity_type="import_batch", actor="pytest")
            .all()
        )
        assert logs, "create_batch 应写审计"
        assert logs[-1].action == AuditAction.IMPORT_LAND.value
        assert logs[-1].action != AuditAction.EXCEPTION_APPROVE.value


class TestIdempotency:
    def test_duplicate_source_name_is_skipped(self, seeded_db, lander, monkeypatch, tmp_path):
        payload = {"records": [{"id": "r1", "日期": "2026-01-01"}]}
        src = tmp_path / "sheet9_orders.json"
        src.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(lander, "SOURCE_DIR", tmp_path)

        from app.domain.history import ImportBatch

        history_service.create_batch(
            seeded_db,
            source_name=lander.SOURCE_FILES["sheet9_orders"][1],
            rows=[{"日期": "2026-01-01"}],
            actor="pytest",
        )
        seeded_db.commit()
        assert seeded_db.query(ImportBatch).count() == 1
        # 再查重应命中
        assert lander.SOURCE_FILES["sheet9_orders"][1] in lander._existing_batches(seeded_db)


class TestRealSourceData:
    """针对仓库内真实 5 份 JSON 的回归（仅在文件存在时运行）。"""

    def test_real_sources_land_without_credentials(self, lander):
        total = 0
        redacted = 0
        for stem in lander.SOURCE_FILES:
            path = lander.SOURCE_DIR / f"{stem}.json"
            if not path.is_file():
                pytest.skip(f"真实源文件缺失：{stem}")
            rows, stats = lander._load(stem)
            total += stats["rows"]
            redacted += stats["redacted_cells"]
            # 脱敏后不得残留任何真实凭据值
            for row in rows:
                for key, value in row.items():
                    if key in lander.SENSITIVE_FIELDS:
                        assert value == lander.REDACTED, f"{stem} 的 {key} 未脱敏"
        assert total == 340, f"源数据应 340 行，实得 {total}"
        assert redacted == 111, f"脱敏格数应 111，实得 {redacted}"

    def test_real_cashflow_keeps_operating_expense_verbatim(self, lander):
        path = lander.SOURCE_DIR / "sheet3_cashflow.json"
        if not path.is_file():
            pytest.skip("真实源文件缺失")
        rows, _ = lander._load("sheet3_cashflow")
        categories = {r.get("类别") for r in rows}
        assert "房租/日用" in categories
        assert "房租日用" not in categories
