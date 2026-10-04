"""T01 / SYS-01-01：Alembic 迁移 — 可重复执行、不覆盖旧库、Up/Down 闭环。"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

BACKEND_DIR = Path(__file__).resolve().parents[2]

EXPECTED_TABLES = {
    "pools",
    "order_type_defs",
    "order_type_pools",
    "document_sequences",
    "audit_logs",
    "alembic_version",
}


def _alembic(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    merged = {**os.environ, **env}
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_DIR,
        env=merged,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture()
def migration_env(tmp_path):
    db_file = tmp_path / "migration_v1.db"
    return {
        "DATABASE_URL": f"sqlite:///{db_file}",
        "APP_ENV": "development",
    }, db_file


def test_upgrade_creates_v1_schema_and_seeds(migration_env):
    env, db_file = migration_env
    result = _alembic(env, "upgrade", "head")
    assert result.returncode == 0, result.stdout + result.stderr
    assert db_file.exists(), "迁移没有创建 v1 库"

    engine = create_engine(f"sqlite:///{db_file}")
    try:
        with engine.connect() as connection:
            tables = set(inspect(connection).get_table_names())
            assert EXPECTED_TABLES <= tables

            pools = {row[0] for row in connection.execute(text("SELECT code FROM pools"))}
            assert pools == {"HJ_INVEST", "HJ_PROFIT"}

            types = {
                row[0]: row[1]
                for row in connection.execute(
                    text("SELECT code, capital_type FROM order_type_defs ORDER BY code")
                )
            }
            assert types == {
                "HS": "STOCK",
                "TH": "PASS_THRU",
                "DG": "ZERO",
                "DFQ": "CREDIT",
            }

            routes = {
                row[0]: row[1]
                for row in connection.execute(
                    text(
                        "SELECT t.code || '/' || p.portion, pool.code "
                        "FROM order_type_pools p "
                        "JOIN order_type_defs t ON t.id = p.order_type_id "
                        "JOIN pools pool ON pool.id = p.pool_id"
                    )
                )
            }
            assert routes["HS/PRINCIPAL"] == "HJ_INVEST"
            assert routes["HS/PROFIT"] == "HJ_PROFIT"
            assert routes["DG/GROSS"] == "HJ_PROFIT"

            sequences = {
                row[0] for row in connection.execute(text("SELECT sequence_key FROM document_sequences"))
            }
            assert {"ORDER_HS", "ORDER_TH", "ORDER_DG", "ORDER_DFQ", "CUSTOMER", "COUNTERPARTY"} <= sequences
    finally:
        engine.dispose()


def test_upgrade_is_repeatable(migration_env):
    """验收要求：迁移可重复执行，且第二次不重复插种子。"""
    env, db_file = migration_env
    assert _alembic(env, "upgrade", "head").returncode == 0
    second = _alembic(env, "upgrade", "head")
    assert second.returncode == 0, second.stdout + second.stderr

    engine = create_engine(f"sqlite:///{db_file}")
    try:
        with engine.connect() as connection:
            pool_count = connection.execute(text("SELECT COUNT(*) FROM pools")).scalar()
            type_count = connection.execute(text("SELECT COUNT(*) FROM order_type_defs")).scalar()
            route_count = connection.execute(text("SELECT COUNT(*) FROM order_type_pools")).scalar()
        assert (pool_count, type_count, route_count) == (2, 4, 8)
    finally:
        engine.dispose()


def test_downgrade_and_upgrade_roundtrip(migration_env):
    env, db_file = migration_env
    assert _alembic(env, "upgrade", "head").returncode == 0
    assert _alembic(env, "downgrade", "base").returncode == 0

    engine = create_engine(f"sqlite:///{db_file}")
    try:
        with engine.connect() as connection:
            remaining = set(inspect(connection).get_table_names())
            assert remaining == {"alembic_version"}
    finally:
        engine.dispose()

    upgraded = _alembic(env, "upgrade", "head")
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr


def test_migration_refuses_legacy_database(tmp_path):
    """旧库保护：把迁移目标指向 heijin.db 必须在配置层被拒绝。"""
    legacy = tmp_path / "heijin.db"
    legacy.write_bytes(b"")
    result = _alembic({"DATABASE_URL": f"sqlite:///{legacy}"}, "upgrade", "head")
    assert result.returncode != 0
    assert "旧库" in (result.stderr + result.stdout)
