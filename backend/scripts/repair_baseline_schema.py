"""为旧 ECS SQLite 库补齐压平基线 ``0001`` 所需的六项结构。

只用于已经由旧迁移链建成、但与当前 ORM 相比缺少少量字段/索引的库。
执行后仍必须运行 ``stamp_baseline.py``；本脚本不会改写 alembic_version。
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


REQUIRED_TABLES = {
    "order_type_pools",
    "order_events",
    "installments",
    "installment_schedules",
    "rebate_records",
}


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def _indexes(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA index_list({table})")}


def repair(path: Path) -> list[str]:
    """补齐基线缺口，返回本次实际执行的修复项。"""
    actions: list[str] = []
    with sqlite3.connect(path) as connection:
        existing = _tables(connection)
        missing = REQUIRED_TABLES - existing
        if missing:
            raise ValueError(f"缺少前置业务表：{', '.join(sorted(missing))}")

        if "game_type_options" not in existing:
            connection.execute(
                """
                CREATE TABLE game_type_options (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(64) NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    is_active BOOLEAN NOT NULL DEFAULT 1,
                    is_default BOOLEAN NOT NULL DEFAULT 0,
                    created_by VARCHAR(64) NOT NULL DEFAULT 'system',
                    updated_by VARCHAR(64) NOT NULL DEFAULT 'system',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT game_type_sort_order_nonnegative CHECK (sort_order >= 0),
                    CONSTRAINT uq_game_type_options_name UNIQUE (name)
                )
                """
            )
            actions.append("创建表 game_type_options")

        additions = (
            ("order_type_pools", "fund_nature", "VARCHAR(16)"),
            ("order_events", "operator_user_ids", "JSON"),
            ("installments", "final_period_adjustment", "NUMERIC(18, 2) NOT NULL DEFAULT 0"),
        )
        for table, column, definition in additions:
            if column not in _columns(connection, table):
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
                actions.append(f"新增列 {table}.{column}")

        indexes = (
            ("installment_schedules", "ix_installment_schedules_due", "installment_id, due_on, status"),
            ("rebate_records", "ix_rebate_records_source_order", "source_order_id"),
        )
        for table, index, columns in indexes:
            if index not in _indexes(connection, table):
                connection.execute(f"CREATE INDEX {index} ON {table} ({columns})")
                actions.append(f"新增索引 {index}")
    return actions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="待修复的 SQLite 数据库绝对路径")
    args = parser.parse_args()
    path = Path(args.db).expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"数据库不存在：{path}")
    for action in repair(path):
        print(f"[repair_baseline_schema] {action}")
    print(f"[repair_baseline_schema] OK db={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
