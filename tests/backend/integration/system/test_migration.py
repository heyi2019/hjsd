"""MIGRATE-01 T01 / SYS-01-01：单一基线迁移 — 可重复执行、不覆盖旧库、Up/Down 闭环。

SQLite 已于 2026-11 整体下线，本文件全部迁移测试改为在 **PostgreSQL** 上验证：
每次用例向同一 PG 实例申请一个独立的临时库（probe），跑 `alembic upgrade head`，
用 PG 内省断言 schema / 种子数据，teardown 时 `DROP DATABASE ... WITH (FORCE)` 归还。
不触碰 dev / test / release / 生产任何既有库。
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine
import _repo  # 仓库根解析：向上找 pytest.ini，避免写死 parents[N]

# 本文件自建引擎并实际连接（create_engine + connect），不走 v1_engine 夹具，
# 因此 db 标记无法由夹具依赖派生，必须在此显式声明。守卫 test_db_channel.py
# 会核对：凡是「自建引擎且实际连接」的文件，全部用例都必须带 db 标记。
pytestmark = pytest.mark.db

def _backend_root() -> Path:
    # mutmut 会把测试复制到 mutants/ 嵌套下，导致 parents[2] 错位到 mutants 根；
    # 向上找含 alembic.ini 的目录作为真正的 backend 根（正常环境下第一轮即命中，行为不变）。
    p = Path(__file__).resolve()
    for cand in (p, *p.parents):
        if (cand / "alembic.ini").exists():
            return cand
    return _repo.BACKEND_DIR


BACKEND_DIR = _backend_root()

EXPECTED_TABLES = {
    "pools",
    "order_type_defs",
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


def _probe_db_name() -> str:
    return f"heijin_mig_probe_{os.getpid()}_{random.randint(0, 9_999_999)}"


def _admin_engine() -> Engine:
    from app.core.settings import get_settings

    base = get_settings().alembic_url
    return create_engine(base, isolation_level="AUTOCOMMIT")


def _template_db_name() -> str:
    """xdist 下每个 worker 一个独立模板库；串行时保持原名，行为零变化。

    固定名 `heijin_erp_migration_tpl` 会被 4 个 worker 的会话级 fixture 同时
    DROP+CREATE，互相拆台（实测 -n4 时 7 个迁移用例报库被 drop）。加 worker
    后缀与 conftest 的 `heijin_erp_test_gwN` 隔离策略一致。
    """
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    return f"heijin_erp_migration_tpl_{worker}" if worker else "heijin_erp_migration_tpl"


@pytest.fixture(scope="session")
def _migration_template() -> str:
    """会话级模板库：整个会话只跑一次 `alembic upgrade head`。

    [2026-11-03 提速] 原实现每个用例都 `CREATE DATABASE` 并**起子进程**跑一次
    `alembic upgrade head`（Python 解释器启动 + 加载整个 app 是主要成本），单次
    中位 2.1s，13 个用例合计约 28s，占全量 117s 的 24%。

    改为 PG 的文件级拷贝 `CREATE DATABASE ... TEMPLATE`：隔离语义不变（每个用例
    仍是自己的独立库，drop 后即消失），建库降到百毫秒级。需要真跑迁移的用例
    （`test_upgrade_is_repeatable` / `test_downgrade_and_upgrade_roundtrip`）
    仍对拷贝出来的库自己调 `_alembic`，不受影响。
    """
    from app.core.settings import get_settings

    template_db = _template_db_name()
    base = get_settings().alembic_url
    parsed = urlparse(base)
    admin = _admin_engine()
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{template_db}" WITH (FORCE)')
            conn.exec_driver_sql(f'CREATE DATABASE "{template_db}"')
    finally:
        admin.dispose()

    target = base.replace(f"/{parsed.path.lstrip('/')}", f"/{template_db}")
    env = {"DATABASE_URL": target, "APP_ENV": "development"}
    result = _alembic(env, "upgrade", "head")
    assert result.returncode == 0, result.stdout + result.stderr

    yield template_db

    admin = _admin_engine()
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{template_db}" WITH (FORCE)')
    finally:
        admin.dispose()


def _provision_probe_db(template: str) -> tuple[str, dict[str, str]]:
    """从模板库拷贝出一个全新的临时库（已处于 head 结构）。"""
    from app.core.settings import get_settings

    base = get_settings().alembic_url
    parsed = urlparse(base)
    db_name = _probe_db_name()
    admin = _admin_engine()
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE DATABASE "{db_name}" TEMPLATE "{template}"')
    finally:
        admin.dispose()

    target = base.replace(f"/{parsed.path.lstrip('/')}", f"/{db_name}")
    env = {"DATABASE_URL": target, "APP_ENV": "development"}
    return target, env


def _drop_probe_db(target: str) -> None:
    parsed = urlparse(target)
    db_name = parsed.path.lstrip("/")
    admin = _admin_engine()
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE "{db_name}" WITH (FORCE)')
    finally:
        admin.dispose()


@pytest.fixture()
def migration_db(_migration_template: str):
    """临时 PG 库：从会话级模板库拷贝（结构已在 head），teardown 时强制删除。

    返回 (engine, target_url, env) —— engine 用于内省；target_url/env 用于二次迁移。
    """
    target, env = _provision_probe_db(_migration_template)
    engine = create_engine(target)
    try:
        yield engine, target, env
    finally:
        engine.dispose()
        _drop_probe_db(target)


def _check_clauses(engine: Engine, table: str) -> str:
    """汇总某张表的 CHECK 约束定义文本（跨方言：SQLAlchemy inspector）。"""
    checks = inspect(engine).get_check_constraints(table)
    return " ".join(c.get("sqltext") or "" for c in checks)


def _column_names(engine: Engine, table: str) -> set[str]:
    return {c["name"] for c in inspect(engine).get_columns(table)}


def _unique_index_names(engine: Engine, table: str) -> set[str]:
    return {i["name"] for i in inspect(engine).get_indexes(table) if i.get("unique")}


def test_migration_target_must_be_postgres():
    """迁移目标必须是 PostgreSQL（SQLite 已整体下线）。"""
    from app.core.settings import get_settings

    assert get_settings().alembic_url.startswith("postgresql"), (
        "alembic_url 必须指向 PostgreSQL，SQLite 已不支持"
    )


def test_upgrade_creates_v1_schema_and_seeds(migration_db):
    engine, _target, _env = migration_db
    tables = set(inspect(engine).get_table_names())
    assert EXPECTED_TABLES <= tables
    # 分次结算模型层 11-05 下线：活动基线靠 create_all 按 ORM 建表，
    # 全新库不能再长出这张无人写入的死表（已有库的历史表保留不 drop）。
    assert "rebate_settlements" not in tables

    deposit_columns = _column_names(engine, "deposits")
    assert "deposit_no" not in deposit_columns
    installment_columns = _column_names(engine, "installments")
    assert "account_id" not in installment_columns
    assert "final_period_adjustment" in installment_columns
    event_columns = _column_names(engine, "order_events")
    assert "operator_user_ids" in event_columns
    disposition_columns = {
        c["name"]: (c.get("default"), c.get("server_default"))
        for c in inspect(engine).get_columns("installment_dispositions")
    }
    assert (
        disposition_columns["created_at"][0] is not None
        or disposition_columns["created_at"][1] is not None
    )
    assert (
        disposition_columns["updated_at"][0] is not None
        or disposition_columns["updated_at"][1] is not None
    )
    rebate_columns = _column_names(engine, "rebate_records")
    assert "rebate_no" in rebate_columns
    assert "operator_user_ids" in rebate_columns
    assert "expected_on" not in rebate_columns
    assert "rebate_group_no" not in rebate_columns
    rebate_source = next(
        c for c in inspect(engine).get_columns("rebate_records") if c["name"] == "source_order_id"
    )
    assert rebate_source["nullable"] is False

    with engine.connect() as connection:
        legacy_rebate_action_fields = connection.execute(
            text(
                "SELECT COUNT(*) FROM order_form_fields "
                "WHERE order_type_code IN ('REBSETTLE', 'REBREVERSE', 'REBATEVOID')"
            )
        ).scalar_one()
        assert legacy_rebate_action_fields == 0

        # source_kind 通过 CHECK 约束限定为 5 种标准导入类型，LEGACY_ORDER 已下线。
        source_kind_clause = _check_clauses(engine, "import_batches")
        for source_kind in (
            "STANDARD_ORDER",
            "STANDARD_ACCOUNT",
            "STANDARD_CASHFLOW",
            "STANDARD_INSTALLMENT",
            "STANDARD_LEAD",
        ):
            assert source_kind in source_kind_clause
        assert "LEGACY_ORDER" not in source_kind_clause

        # 库存唯一索引必须是业务键（KU_+5），旧 uq_stocks_inventory_no 已退役。
        assert "uq_stocks_inventory_no" not in _unique_index_names(engine, "stocks")

        account_columns = _column_names(engine, "stocks")
        assert "inventory_no" not in account_columns
        assert "risk_level" not in account_columns
        assert "region" not in account_columns
        assert "channels" not in account_columns

        type_columns = _column_names(engine, "order_type_defs")
        assert "is_zero_principal" in type_columns
        assert "capital_type" not in type_columns
        pool_columns = _column_names(engine, "pools")
        assert "is_default" in pool_columns

        # 资金流水 CHECK：INTERNAL 必须绑定 TRANSFER 来源（跨方言只看约束语义）。
        cashflow_clause = _check_clauses(engine, "cashflow")
        assert "INTERNAL" in cashflow_clause
        assert "source_type" in cashflow_clause
        assert "IS NOT NULL" in cashflow_clause

        pools = {row[0] for row in connection.execute(text("SELECT code FROM pools"))}
        assert pools == {"HJ_INVEST", "HJ_PROFIT"}

        types = {row[0] for row in connection.execute(text("SELECT code FROM order_type_defs"))}
        assert types == {"HS", "TH", "DG"}


        sequences = {
            row[0] for row in connection.execute(text("SELECT sequence_key FROM document_sequences"))
        }
        assert {"ORDER_HS", "ORDER_TH", "ORDER_DG", "CUSTOMER", "COUNTERPARTY"} <= sequences
        # EVENT/REBATE 仍禁止。
        assert {"EVENT", "REBATE"}.isdisjoint(sequences)
        # 2026-10-28 裁决：资金流水按方向独立编号（支出 ZC+五位 / 收入 SR+五位），CF 共用域退役。
        assert connection.execute(
            text(
                "SELECT sequence_key || '=' || prefix || '=' || padding FROM document_sequences "
                "WHERE sequence_key IN ('CASHFLOW_OUT', 'CASHFLOW_IN') ORDER BY sequence_key"
            )
        ).fetchall() == [("CASHFLOW_IN=SR=5",), ("CASHFLOW_OUT=ZC=5",)]
        assert {"CASHFLOW"}.isdisjoint(sequences)


def test_postgres_alembic_version_storage_allows_long_revision_ids():
    """PostgreSQL 迁移版本名超过 Alembic 默认 32 字符时仍能写入版本表。"""
    env_source = (BACKEND_DIR / "alembic" / "env.py").read_text(encoding="utf-8")
    assert "VARCHAR(64)" in env_source


def test_order_cancel_amount_is_incoming_finance_flow(migration_db):
    """取消的冲销金额应记录为退款入账，而非原始支出。"""
    engine, _target, _env = migration_db
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT section, flow_direction FROM order_form_fields "
                "WHERE order_type_code = 'ORDERCANC' AND field_key = 'cancel_amount'"
            )
        ).one()
    assert row.section == "FINANCE"
    assert row.flow_direction == "IN"


def test_consignment_platform_field_is_operation_section(migration_db):
    """寄售平台登记属于账号运营动作，不应归到交付板块。"""
    engine, _target, _env = migration_db
    with engine.connect() as connection:
        section = connection.execute(
            text(
                "SELECT section FROM order_form_fields "
                "WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'"
            )
        ).scalar_one()
    assert section == "OPERATION"


def test_refund_form_is_reframed_as_cash_outflow(migration_db):
    """资金收支表单保留当前基线中的责任方、日期和固定支出流向。"""
    engine, _target, _env = migration_db
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT field_key, field_type, is_active, options FROM order_form_fields "
                "WHERE order_type_code = 'REFUND'"
            )
        ).fetchall()
        by_key = {r[0]: r for r in rows}
        assert "refund_responsibility" in by_key, "应保留 责任方 字段"
        assert by_key["refund_responsibility"][2] == 0, "refund_responsibility 应停用"
        assert "occurred_on" in by_key, "应新增 发生日期 字段"
        assert by_key["occurred_on"][1] == "DATE", "发生日期 应为 DATE 类型"
        assert "direction" in by_key, "应新增 资金流向 字段"
        direction_opts = by_key["direction"][3]
        direction_opts = direction_opts if isinstance(direction_opts, list) else json.loads(direction_opts)
        assert any(o.get("value") == "OUT" for o in direction_opts), "资金流向 应为支出(OUT)"


def test_upgrade_is_repeatable(migration_db):
    """验收要求：迁移可重复执行，且第二次不重复插种子。"""
    engine, target, env = migration_db
    second = _alembic(env, "upgrade", "head")
    assert second.returncode == 0, second.stdout + second.stderr

    with engine.connect() as connection:
        pool_count = connection.execute(text("SELECT COUNT(*) FROM pools")).scalar()
        type_count = connection.execute(text("SELECT COUNT(*) FROM order_type_defs")).scalar()
    assert (pool_count, type_count) == (2, 3)


def test_current_migration_head_is_exposed():
    result = _alembic({}, "heads")
    assert result.returncode == 0, result.stdout + result.stderr
    stdout = result.stdout.strip()
    # alembic heads 形如 "0025 (head)"；head 必须真实存在且被 alembic 识别。
    # 不再硬编码 revision —— 迁移链推进后硬编码值会腐化（此前 0010 已落后于实际 head）。
    assert "(head)" in stdout, f"alembic heads 未报告 head：\n{stdout}"
    head_rev = stdout.split()[0]
    version_files = [
        p.name for p in (BACKEND_DIR / "alembic" / "squashed_versions").glob("*.py")
    ]
    assert any(head_rev in name for name in version_files), (
        f"head {head_rev} 在活动迁移目录中找不到对应文件：{version_files}"
    )


def test_active_migration_chain_is_single_current_baseline():
    """新环境只允许从当前 ORM 基线 0001 初始化，不加载旧库兼容迁移。"""
    result = _alembic({}, "heads")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "0001 (head)"

    active_dir = BACKEND_DIR / "alembic" / "squashed_versions"
    active_files = sorted(path.name for path in active_dir.glob("*.py"))
    assert active_files == ["0001_current_schema_baseline.py"]


def test_downgrade_and_upgrade_roundtrip(migration_db):
    engine, target, env = migration_db
    assert _alembic(env, "downgrade", "base").returncode == 0

    with engine.connect() as connection:
        remaining = set(inspect(connection).get_table_names())
        assert remaining == {"alembic_version"}

    upgraded = _alembic(env, "upgrade", "head")
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr


def test_orders_status_check_dropped_draft(migration_db):
    """0011 移除草稿态后：迁移产出的 orders CHECK 必须真的不含 DRAFT。

    双向断言的原因：`alembic check` 不校验 CHECK 内容，删/加枚举值若漏了迁移它照样报绿。
    ① 当前 OrderStatus 全部可写入 → 防止以后加枚举值却忘了重建表；
    ② 'DRAFT' 必须被 CHECK 拒绝 → 防止本次迁移没真正生效。
    跨方言用约束定义文本断言（PG 将 IN 渲染为 = ANY(ARRAY[...])，故只校验成员与排除项）。
    """
    from app.domain.enums import OrderStatus

    engine, _target, _env = migration_db
    clause = _check_clauses(engine, "orders")
    for status in OrderStatus:
        assert f"'{status.value}'" in clause, f"orders CHECK 缺少 {status.value}：{clause}"
    assert "DRAFT" not in clause, f"orders CHECK 不应含 DRAFT：{clause}"


def test_order_event_portion_check_matches_domain_enum(migration_db):
    """事件份额必须与 Portion 枚举一致，非法份额不能进入核算表。"""
    from app.domain.enums import Portion

    engine, _target, _env = migration_db
    clause = _check_clauses(engine, "order_events")
    for value in Portion.values():
        assert f"'{value}'" in clause, f"order_events CHECK 缺少 {value}：{clause}"


def test_accounts_status_check_drops_legacy_pending(migration_db):
    """账号周期不再保留 INSTALLMENT，分期阶段由订单/分期状态承载。"""
    engine, _target, _env = migration_db
    clause = _check_clauses(engine, "stocks")
    assert "'PENDING'" not in clause
    for value in ("WAITING", "SOLD", "VOID"):
        assert f"'{value}'" in clause, f"stocks CHECK 应含 {value}：{clause}"


def test_retired_product_checks_are_removed(migration_db):
    """下线代分期后，数据库约束不得继续接受历史枚举值。"""
    engine, _target, _env = migration_db
    orders_clause = _check_clauses(engine, "orders")
    type_defs_clause = _check_clauses(engine, "order_type_defs")
    installments_clause = _check_clauses(engine, "installments")
    cashflow_clause = _check_clauses(engine, "cashflow")

    assert "'CREDIT'" not in orders_clause
    assert "'CREDIT'" not in type_defs_clause
    assert "'ADVANCE_PURCHASE'" not in installments_clause
    assert "'DFQ_PRINCIPAL'" not in cashflow_clause


def test_account_status_rename_migrates_legacy_rows_without_touching_inventory_status(migration_db):
    """库存周期状态由 IN_STOCK 更名为 WAITING，库存状态保持独立列不被更名触碰。

    squash 后无法停在中间态复现「已存在旧 status 行」，故改为验证最终 schema：
    stocks.status 的 CHECK 已更名为 WAITING（不再含 IN_STOCK），且 inventory_status
    作为独立列共存。
    """
    engine, _target, _env = migration_db
    cols = _column_names(engine, "stocks")
    assert "inventory_status" in cols, "库存状态应独立保留为列"
    checks = inspect(engine).get_check_constraints("stocks")
    # 只取 status 约束（排除 inventory_status 那条，后者合法含 IN_STOCK）。
    status_clause = next(
        c["sqltext"]
        for c in checks
        if "inventory_status" not in c["sqltext"]
        and all(v in c["sqltext"] for v in ("WAITING", "SOLD", "VOID"))
    )
    assert "WAITING" in status_clause, "status 应已更名为 WAITING"
    assert "IN_STOCK" not in status_clause, "旧 IN_STOCK 应从 status CHECK 移除"


def test_installment_status_options_hide_internal_pending(migration_db):
    """PENDING 仅保留内部流程使用，不进入分期业务状态词典。"""
    engine, _target, _env = migration_db
    with engine.connect() as connection:
        raw = connection.execute(
            text("SELECT options FROM option_sets WHERE code = 'INSTALLMENT_STATUS'")
        ).scalar_one()
        values = raw if isinstance(raw, list) else json.loads(raw)
        assert [item["value"] for item in values] == [
            "ACTIVE", "OVERDUE", "SETTLED", "DELIVERED", "DEFAULTED", "CLOSED", "CANCELLED"
        ]
        assert values[0]["label"] == "还款中"
