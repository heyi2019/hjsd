"""T01 / SYS-01-01：单一基线迁移 — 可重复执行、不覆盖旧库、Up/Down 闭环。"""
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
            deposit_columns = {column["name"] for column in inspect(connection).get_columns("deposits")}
            assert "deposit_no" not in deposit_columns
            installment_columns = {
                column["name"] for column in inspect(connection).get_columns("installments")
            }
            assert "account_id" not in installment_columns
            rebate_columns = {column["name"] for column in inspect(connection).get_columns("rebate_records")}
            assert "rebate_no" in rebate_columns
            assert "rebate_group_no" not in rebate_columns
            rebate_source = next(
                column for column in inspect(connection).get_columns("rebate_records")
                if column["name"] == "source_order_id"
            )
            assert rebate_source["nullable"] is False
            import_source = next(
                column for column in inspect(connection).get_columns("import_batches")
                if column["name"] == "source_kind"
            )
            assert "STANDARD_ORDER" in str(import_source["default"])
            import_sql = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='import_batches'")
            ).scalar_one()
            for source_kind in (
                "STANDARD_ORDER",
                "STANDARD_ACCOUNT",
                "STANDARD_CASHFLOW",
                "STANDARD_INSTALLMENT",
                "STANDARD_LEAD",
            ):
                assert source_kind in import_sql
            assert "LEGACY_ORDER" not in import_sql
            inventory_indexes = {
                index["name"]
                for index in inspect(connection).get_indexes("accounts")
                if index["unique"]
            }
            assert "uq_accounts_inventory_no" in inventory_indexes
            account_columns = {column["name"] for column in inspect(connection).get_columns("accounts")}
            assert "risk_level" not in account_columns
            assert "region" not in account_columns
            assert "channels" not in account_columns
            quality_columns = {
                column["name"] for column in inspect(connection).get_columns("quality_issues")
            }
            assert "assignee_id" not in quality_columns
            cashflow_sql = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='cashflow'")
            ).scalar_one()
            assert "nature != 'INTERNAL' OR transfer_id IS NOT NULL" in cashflow_sql

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
            assert {"INSTALLMENT", "EVENT", "REBATE"}.isdisjoint(sequences)
            assert connection.execute(
                text("SELECT prefix FROM document_sequences WHERE sequence_key = 'CASHFLOW'")
            ).scalar_one() == "CF"
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


def test_only_current_baseline_is_exposed():
    result = _alembic({}, "heads")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "0002 (head)"


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


def test_orders_status_check_dropped_draft(migration_env):
    """0011 移除草稿态后：迁移产出的 orders CHECK 必须真的不含 DRAFT。

    双向断言的原因：`alembic check` 不校验 SQLite 的 CHECK 内容（实测为
    「No new upgrade operations detected」），删/加枚举值若漏了迁移它照样报绿。
    ① 当前 OrderStatus 全部可写入 → 防止以后加枚举值却忘了重建表；
    ② 'DRAFT' 必须被 CHECK 拒绝 → 防止本次迁移没真正生效。
    """
    from app.domain.enums import OrderStatus

    env, db_file = migration_env
    assert _alembic(env, "upgrade", "head").returncode == 0

    engine = create_engine(f"sqlite:///{db_file}")
    # created_by/updated_by 磁盘上是 NOT NULL 且无 server_default，裸 SQL 必须自带
    insert = (
        "INSERT INTO orders (order_no, order_type, capital_type, trade_date, status, "
        "link_status, created_by, updated_by) VALUES (:no, 'HS', 'STOCK', '2026-01-01', "
        ":status, 'LINKED', 'pytest', 'pytest')"
    )
    try:
        with engine.connect() as connection:
            check = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'")
            ).scalar()
            expected = ", ".join(f"'{v}'" for v in OrderStatus.values())
            assert f"status IN ({expected})" in check, f"orders CHECK 与 OrderStatus 不一致：{check}"

            for status in OrderStatus:
                connection.execute(
                    text(insert), {"no": f"CHK-{status.value}", "status": status.value}
                )
            with pytest.raises(Exception):  # noqa: BLE001   CHECK 拒绝即达标
                connection.execute(text(insert), {"no": "CHK-DRAFT", "status": "DRAFT"})
            connection.rollback()
    finally:
        engine.dispose()


def test_order_event_portion_check_matches_domain_enum(migration_env):
    """事件份额必须与 Portion 枚举一致，非法份额不能进入核算表。"""
    from app.domain.enums import Portion

    env, db_file = migration_env
    assert _alembic(env, "upgrade", "head").returncode == 0

    engine = create_engine(f"sqlite:///{db_file}")
    try:
        with engine.connect() as connection:
            create_sql = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_events'")
            ).scalar_one()
            expected = ", ".join(f"'{value}'" for value in Portion.values())
            assert f"portion IN ({expected})" in create_sql, create_sql
    finally:
        engine.dispose()


def test_accounts_status_check_drops_legacy_pending(migration_env):
    """账号不再保留旧 PENDING/待收状态，迁移后默认直接进入在库。"""
    env, db_file = migration_env
    result = _alembic(env, "upgrade", "head")
    assert result.returncode == 0, result.stdout + result.stderr

    engine = create_engine(f"sqlite:///{db_file}")
    try:
        with engine.connect() as connection:
            create_sql = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'")
            ).scalar_one()
            assert "'PENDING'" not in create_sql
            expected = "status IN ('IN_STOCK', 'INSTALLMENT', 'SOLD', 'VOID')"
            assert expected in create_sql
    finally:
        engine.dispose()


def test_migration_refuses_legacy_database(tmp_path):
    """旧库保护：把迁移目标指向 heijin.db 必须在配置层被拒绝。"""
    legacy = tmp_path / "heijin.db"
    legacy.write_bytes(b"")
    result = _alembic({"DATABASE_URL": f"sqlite:///{legacy}"}, "upgrade", "head")
    assert result.returncode != 0
    assert "旧库" in (result.stderr + result.stdout)
