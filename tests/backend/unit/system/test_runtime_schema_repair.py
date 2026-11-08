"""DEPLOY-01：运行时 schema 兼容修复，存量库不能因已下线的非空列阻断写入。"""
from __future__ import annotations

from scripts import repair_runtime_schema


class _FakeConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, statement) -> None:
        self.statements.append(str(statement))

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


class _FakeEngine:
    def __init__(self) -> None:
        self.connection = _FakeConnection()

    def begin(self):
        return self.connection


def test_repair_runtime_schema_removes_retired_columns_from_all_write_tables():
    engine = _FakeEngine()

    repair_runtime_schema.repair_runtime_schema(engine)

    assert engine.connection.statements == [
        'ALTER TABLE public."order_type_defs" DROP COLUMN IF EXISTS capital_type CASCADE',
        'ALTER TABLE public."orders" DROP COLUMN IF EXISTS capital_type CASCADE',
        'ALTER TABLE public."order_type_pools" DROP COLUMN IF EXISTS fund_nature CASCADE',
        'ALTER TABLE public."cashflow" DROP COLUMN IF EXISTS fund_nature CASCADE',
        'ALTER TABLE public."cashflow" DROP COLUMN IF EXISTS nature CASCADE',
        'ALTER TABLE public."cashflow" ADD COLUMN IF NOT EXISTS accounting_attribute '
        "VARCHAR(32) NOT NULL DEFAULT 'EXPENSE'",
    ]
