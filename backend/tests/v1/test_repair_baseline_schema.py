"""旧 ECS SQLite 库在 stamp 为 0001 前的最小结构补齐。"""
from __future__ import annotations

import sqlite3
import subprocess
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[2]


def _legacy_schema(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE order_type_pools (id INTEGER PRIMARY KEY, order_type_id INTEGER, pool_id INTEGER, portion TEXT, priority INTEGER, is_active BOOLEAN, created_at DATETIME, updated_at DATETIME, UNIQUE(order_type_id, portion));
            CREATE TABLE order_events (id INTEGER PRIMARY KEY, event_no TEXT, order_id INTEGER);
            CREATE TABLE installments (id INTEGER PRIMARY KEY, inst_no TEXT, order_id INTEGER);
            CREATE TABLE installment_schedules (id INTEGER PRIMARY KEY, installment_id INTEGER, due_on DATE, status TEXT);
            CREATE TABLE rebate_records (id INTEGER PRIMARY KEY, source_order_id INTEGER);
            CREATE INDEX ix_schedules_due ON installment_schedules (installment_id, due_on, status);
            CREATE INDEX ix_rebate_source_order ON rebate_records (source_order_id);
            """
        )


def test_repair_baseline_schema_adds_only_required_legacy_gaps(tmp_path):
    db_file = tmp_path / "legacy.db"
    _legacy_schema(db_file)

    result = subprocess.run(
        [sys.executable, "scripts/repair_baseline_schema.py", "--db", str(db_file)],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    with sqlite3.connect(db_file) as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "game_type_options" in tables
        assert {row[1] for row in conn.execute("PRAGMA table_info(order_type_pools)")} >= {"fund_nature"}
        assert {row[1] for row in conn.execute("PRAGMA table_info(order_events)")} >= {"operator_user_ids"}
        assert {row[1] for row in conn.execute("PRAGMA table_info(installments)")} >= {"final_period_adjustment"}
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(installment_schedules)")}
        assert "ix_installment_schedules_due" in indexes
        assert "ix_schedules_due" not in indexes
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(rebate_records)")}
        assert "ix_rebate_records_source_order" in indexes
        assert "ix_rebate_source_order" not in indexes
        unique_indexes = [row[1] for row in conn.execute("PRAGMA index_list(order_type_pools)") if row[2]]
        assert any(
            {item[2] for item in conn.execute(f"PRAGMA index_info({index})")}
            == {"order_type_id", "portion", "fund_nature"}
            for index in unique_indexes
        )
