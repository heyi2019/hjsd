"""IMPORT-01 导入的原始值与「只落原文」红线测试（MIG-01）。

这些用例守护的是 PRD §23 与导入回归锁死项，**不是**覆盖率：
导入不得改写源文件原始值。
"""

from __future__ import annotations

import importlib.util
import json

import pytest

from app.domain.enums import AuditAction, ImportBatchStatus, ImportRowStatus
from app.imports import batches as imp_batches
import _repo  # 仓库根解析：向上找 pytest.ini，避免写死 parents[N]


def _load_script():
    """按路径加载 scripts/land_raw_import.py（脚本目录不在包内）。"""
    path = _repo.BACKEND_DIR / "scripts" / "land_raw_import.py"
    spec = importlib.util.spec_from_file_location("land_raw_import", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def lander():
    return _load_script()


class TestRawValues:
    """导入字段完整保留，不做脱敏或字段剥离。"""

    def test_sensitive_values_are_preserved(self, lander, monkeypatch, tmp_path):
        payload = {"records": [{"日期": "2026-01-01", "密码": "secret", "绑定手机号": "13800001111"}]}
        (tmp_path / "sheet9_orders.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        monkeypatch.setattr(lander, "SOURCE_DIR", tmp_path)
        rows, _stats = lander._load("sheet9_orders")
        assert rows[0]["密码"] == "secret"
        assert rows[0]["绑定手机号"] == "13800001111"


class TestRawPreservation:
    """原始值必须逐字保留，不做归一化。"""

    def test_operating_expense_category_keeps_slash(self, lander):
        """回归锁死项：写成「房租日用」曾导致 ¥11,989.90 漏计。"""
        cleaned = {"类别": "房租/日用"}
        assert cleaned["类别"] == "房租/日用"
        assert cleaned["类别"] != "房租日用"

    def test_pool_names_kept_verbatim(self, lander):
        cleaned = {"回款账户（本金/利润）": ["投资款荷包（本金）", "利润荷包（利润）"]}
        assert cleaned["回款账户（本金/利润）"] == ["投资款荷包（本金）", "利润荷包（利润）"]

    def test_source_id_preserved_for_traceback(self, lander, monkeypatch, tmp_path):
        """金山文档行 ID 必须保留，便于回溯原文位置。"""
        payload = {"records": [{"id": "rec_abc", "日期": "2026-01-01", "密码": "x"}]}
        src = tmp_path / "sheet9_orders.json"
        src.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(lander, "SOURCE_DIR", tmp_path)
        rows, _stats = lander._load("sheet9_orders")
        assert rows[0]["_source_id"] == "rec_abc"
        assert rows[0]["密码"] == "x"

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
        assert [r["账密"] for r in rows] == ["p", "q"]


class TestNoInference:
    """落地只写原文，绝不推断或自动匹配。"""

    def test_create_batch_writes_no_mapping(self, seeded_db):
        batch = imp_batches.create_batch(
            seeded_db,
            source_name="测试批次",
            rows=[{"日期": "2026-01-01", "本金": 100}],
            actor="pytest",
        )
        assert batch["row_count"] == 1
        assert batch["unmapped_count"] == 1
        assert batch["status"] == ImportBatchStatus.DRAFT.value

        from app.domain.imports import ImportRow

        row = seeded_db.query(ImportRow).filter_by(batch_id=batch["id"]).one()
        assert row.status == ImportRowStatus.UNMAPPED.value
        assert row.mapped_order_id is None
        assert row.mapped_account_id is None

    def test_land_audit_uses_dedicated_action(self, seeded_db):
        """导入审计不得借用 EXCEPTION_APPROVE（否则日志被误读为异常审批）。"""
        imp_batches.create_batch(
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

        from app.domain.imports import ImportBatch

        imp_batches.create_batch(
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
        for stem in lander.SOURCE_FILES:
            path = lander.SOURCE_DIR / f"{stem}.json"
            if not path.is_file():
                pytest.skip(f"真实源文件缺失：{stem}")
            rows, stats = lander._load(stem)
            total += stats["rows"]
        assert total == 340, f"源数据应 340 行，实得 {total}"

    def test_real_cashflow_keeps_operating_expense_verbatim(self, lander):
        path = lander.SOURCE_DIR / "sheet3_cashflow.json"
        if not path.is_file():
            pytest.skip("真实源文件缺失")
        rows, _ = lander._load("sheet3_cashflow")
        categories = {r.get("类别") for r in rows}
        assert "房租/日用" in categories
        assert "房租日用" not in categories
