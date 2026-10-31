"""Copy the v1 SQLite database into an empty PostgreSQL database.

This is an operational migration tool, not a general-purpose SQLite converter.
It creates the current ORM schema, copies rows in foreign-key order, repairs
PostgreSQL identity sequences, and stamps Alembic at the current head.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.types import Boolean, Date, DateTime, JSON

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import Base  # noqa: E402
from app.domain import (  # noqa: E402,F401
    attachments,
    foundation,
    imports,
    lists,
    notifications,
    options,
    parties,
    quality,
    trade,
    users,
)

# 导入领域模块会把全部 ORM 模型注册到 Base.metadata；保留显式集合也让静态检查
# 知道这些导入是迁移前置条件，而非多余依赖。
REGISTERED_DOMAIN_MODULES = (
    attachments,
    foundation,
    imports,
    lists,
    notifications,
    options,
    parties,
    quality,
    trade,
    users,
)


def _convert(value: object, column_type: object) -> object:
    if value is None:
        return None
    if isinstance(column_type, JSON):
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return value
        return value
    if isinstance(column_type, Boolean):
        if isinstance(value, str):
            return value.strip().lower() not in {"", "0", "false", "no"}
        return bool(value)
    if isinstance(column_type, DateTime) and isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    if isinstance(column_type, Date) and not isinstance(column_type, DateTime) and isinstance(value, str):
        return date.fromisoformat(value[:10])
    return value


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def migrate(source_path: Path, target_url: str, revision: str) -> tuple[int, int]:
    if not source_path.is_file():
        raise SystemExit(f"源数据库不存在: {source_path}")

    target = create_engine(target_url, future=True)
    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    try:
        existing = set(inspect(target).get_table_names())
        blocked = sorted(existing - {"alembic_version"})
        if blocked:
            raise SystemExit(
                "目标 PostgreSQL 不是空库，拒绝迁移；已有表: " + ", ".join(blocked[:20])
            )

        Base.metadata.create_all(target)
        with target.begin() as connection:
            connection.execute(
                text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)")
            )
            connection.execute(text("DELETE FROM alembic_version"))

        source_tables = {
            row[0]
            for row in source.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        total_rows = 0
        copied_tables = 0
        with target.begin() as connection:
            for table in Base.metadata.sorted_tables:
                if table.name not in source_tables:
                    raise SystemExit(f"源数据库缺少 ORM 表: {table.name}")
                source_columns = {
                    row[1]
                    for row in source.execute(f"PRAGMA table_info({_quote(table.name)})")
                }
                columns = [column for column in table.columns if column.name in source_columns]
                rows = source.execute(f"SELECT * FROM {_quote(table.name)}").fetchall()
                if rows:
                    payload = [
                        {
                            column.name: _convert(row[column.name], column.type)
                            for column in columns
                        }
                        for row in rows
                    ]
                    for start in range(0, len(payload), 500):
                        connection.execute(table.insert(), payload[start : start + 500])
                copied_tables += 1
                total_rows += len(rows)

                if "id" in table.c:
                    max_id = connection.execute(text(f"SELECT MAX({_quote('id')}) FROM {_quote(table.name)}")).scalar()
                    sequence = connection.execute(
                        text("SELECT pg_get_serial_sequence(:qualified, 'id')"),
                        {"qualified": f"public.{table.name}"},
                    ).scalar()
                    if sequence and max_id is not None:
                        connection.execute(
                            text("SELECT setval(CAST(:sequence AS regclass), :max_id, true)"),
                            {"sequence": sequence, "max_id": int(max_id)},
                        )

            connection.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:revision)"),
                {"revision": revision},
            )
        return copied_tables, total_rows
    finally:
        source.close()
        target.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--revision", default="0071_rename_account_waiting_status")
    args = parser.parse_args()
    tables, rows = migrate(args.source, args.target, args.revision)
    print(f"MIGRATION_OK tables={tables} rows={rows} revision={args.revision}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
