"""E2E 数据库启动时必须清理已退役的非空旧列。"""

from __future__ import annotations

from scripts import e2e_db


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


def test_e2e_keep_mode_drops_retired_non_null_columns() -> None:
    engine = _FakeEngine()

    e2e_db._drop_retired_columns(engine)

    assert engine.connection.statements == [
        'ALTER TABLE public."order_type_defs" DROP COLUMN IF EXISTS capital_type CASCADE',
        'ALTER TABLE public."orders" DROP COLUMN IF EXISTS capital_type CASCADE',
        'ALTER TABLE public."cashflow" DROP COLUMN IF EXISTS nature CASCADE',
    ]
