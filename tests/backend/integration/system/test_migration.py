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
    "idempotency_records",
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


def _provision_probe_db(template: str | None) -> tuple[str, dict[str, str]]:
    """从模板拷贝或创建空的隔离临时库。"""
    from app.core.settings import get_settings

    base = get_settings().alembic_url
    parsed = urlparse(base)
    db_name = _probe_db_name()
    admin = _admin_engine()
    try:
        with admin.connect() as conn:
            suffix = f' TEMPLATE "{template}"' if template else ""
            conn.exec_driver_sql(f'CREATE DATABASE "{db_name}"{suffix}')
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


@pytest.fixture()
def migration_0001_db():
    """独立空库真实执行 0001，供测试真实的 0001→0002 升级。"""
    target, env = _provision_probe_db(None)
    engine = create_engine(target)
    try:
        result = _alembic(env, "upgrade", "0001")
        assert result.returncode == 0, result.stdout + result.stderr
        yield engine, env
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
    # 全新库不能再长出这张无人写入的死表。
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
        assert pools == set()
        assert connection.execute(text("SELECT COUNT(*) FROM game_type_options")).scalar_one() == 0
        option_sets = dict(connection.execute(text("SELECT code, options FROM option_sets")).all())
        for code in ("INTERMEDIARY_PLATFORM", "CUSTOMER_SOURCE", "SUPPLIER_SOURCE", "STUDIO_EXPENSE_ITEM", "STUDIO_EXPENSE_POOL",
                     "INTERMEDIARY_TYPE", "COMPENSATION_TYPE", "REFUND_RESPONSIBILITY", "QUALITY_SEVERITY"):
            assert option_sets[code] == [], code
        fields = {(row[0], row[1]): row[2] for row in connection.execute(
            text("SELECT order_type_code, field_key, options FROM order_form_fields")
        )}
        for key in (("CONSIGN", "platform_ids"), ("CUSTOMER", "game_category"), ("DG", "dg_customer_source"),
                    ("HS", "customer_source"), ("TH", "supplier_source")):
            assert fields[key] == [], key

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
    assert (pool_count, type_count) == (0, 3)



def test_adds_idempotency_storage_to_existing_database_without_reseeding(migration_db):
    engine, _target, env = migration_db
    with engine.begin() as connection:
        connection.execute(text("DROP TABLE IF EXISTS idempotency_records"))
        connection.execute(text("UPDATE order_type_defs SET description = '现有自定义说明' WHERE code = 'HS'"))

    for _ in range(2):
        result = subprocess.run(
            [sys.executable, "-m", "scripts.ensure_idempotency_records", "--apply"],
            cwd=BACKEND_DIR, env={**os.environ, **env}, capture_output=True, text=True, check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr

    keys = inspect(engine).get_unique_constraints("idempotency_records")
    assert any(key["column_names"] == ["user_id", "scope", "key"] for key in keys)
    with engine.connect() as connection:
        description = connection.scalar(text("SELECT description FROM order_type_defs WHERE code = 'HS'"))
        assert description == "现有自定义说明"


def test_active_migration_chain_is_single_current_baseline():
    """活动链为 0001 基线和 0002 字典编码迁移。"""
    result = _alembic({}, "heads")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "0002 (head)"

    active_dir = BACKEND_DIR / "alembic" / "squashed_versions"
    active_files = sorted(path.name for path in active_dir.glob("*.py"))
    assert active_files == ["0001_current_schema_baseline.py", "0002_dictionary_codes.py"]


def test_upgrade_0002_migrates_existing_data_without_changing_financial_links(migration_0001_db):
    from collections import defaultdict
    from datetime import date
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from app.business.inventory.profile import create_account
    from app.business.orders.create import create_order
    from app.domain.foundation import GameTypeOption, Pool
    from app.domain.options import OptionSet
    from app.domain.trade import OrderEvent
    from app.domain.users import User
    from app.finance.cashflow.cashflows import create_cashflow
    from scripts.test_example_seed import seed_example_catalog, seed_example_data

    engine, env = migration_0001_db
    with Session(engine) as session:
        seed_example_data(session, actor="pytest", stats=defaultdict(int))
        seed_example_catalog(session)
        operator = User(username="migration-test", display_name="测试员工", password_hash="test",
                        role="OPERATOR", owner_scope="ALL", is_active=True)
        session.add(operator)
        session.flush()
        game = session.scalar(select(GameTypeOption).where(GameTypeOption.name == "王者荣耀"))
        platform = session.scalar(select(OptionSet).where(OptionSet.code == "INTERMEDIARY_PLATFORM"))
        platform.options = [{"value": "千寻", "label": "千寻"}, {"value": "盼之", "label": "盼之"},
                            {"value": "螃蟹", "label": "螃蟹"}]
        account = create_account(session, game_account="legacy-migration-test", game_type=game.name,
                                 channel_region="安卓QQ", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        account.wallet_realname = "未注销"
        order = create_order(session, order_type="HS", trade_date=date(2026, 1, 1), actor="pytest", account_id=account.id,
                             form_extra={"business_responsible_ids": [operator.id]})
        order.account_snapshot = {"game_type": "王者荣耀", "channel_region": "安卓QQ", "wallet_realname": "未注销"}
        session.add(OrderEvent(order_id=order.id, event_no="MIGRATION-LIST", event_type="OPERATE", amount=0,
                               occurred_on=date(2026, 1, 1), is_posted=True, created_by="pytest", updated_by="pytest",
                               form_extra={"operation_type": "CONSIGNMENT", "consignment_platforms": ["盼之"]}))
        pool = session.scalar(select(Pool).where(Pool.code == "pool_01"))
        flow = create_cashflow(session, pool_id=pool.id, occurred_on=date(2026, 1, 1), direction="IN",
                               category="OTHER", amount="123.45", actor="pytest")
        pool.code = "HJ_INVEST"
        game.channel_regions = ["安卓QQ"]
        session.flush()
        account_id, order_id, flow_id, pool_id = account.id, order.id, flow.id, pool.id
        session.commit()
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE orders DROP COLUMN option_label_snapshot"))
        connection.execute(text("ALTER TABLE attachments ALTER COLUMN attachment_no SET NOT NULL"))

    first = _alembic(env, "upgrade", "head")
    assert first.returncode == 0, first.stdout + first.stderr
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0002"
        assert next(column for column in inspect(connection).get_columns("attachments") if column["name"] == "attachment_no")["nullable"] is True
        stock = connection.execute(text("SELECT game_type, channel_region, wallet_realname FROM stocks WHERE id=:id"), {"id": account_id}).one()
        assert tuple(stock) == ("game_01", "channel_01", "N")
        snapshot = connection.scalar(text("SELECT account_snapshot FROM orders WHERE id=:id"), {"id": order_id})
        assert snapshot["game_type_label"] == "王者荣耀" and snapshot["channel_region_label"] == "安卓QQ"
        event = connection.scalar(text("SELECT form_extra FROM order_events WHERE event_no='MIGRATION-LIST'"))
        assert event["consignment_platforms"] == ["intermediary_platform_02"]
        assert event["consignment_platform_labels"] == {"intermediary_platform_02": "盼之"}
        flow = connection.execute(text("SELECT pool_id, amount FROM cashflow WHERE id=:id"), {"id": flow_id}).one()
        assert flow.pool_id == pool_id and str(flow.amount) == "123.45"
        assert connection.scalar(text("SELECT code FROM pools WHERE id=:id"), {"id": pool_id}) == "pool_03"
        assert connection.scalar(text("SELECT COUNT(*) FROM audit_logs WHERE entity_type='dictionary_migration' AND entity_id='0002'")) == 1
    again = _alembic(env, "upgrade", "head")
    assert again.returncode == 0, again.stdout + again.stderr


def test_upgrade_0002_keeps_custom_option_names_in_detail_and_export(migration_0001_db):
    import csv
    import io
    from datetime import date
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from app.business.shared.order_detail.view.derived import _extras
    from app.business.shared.order_detail.view.execution_schemas import AccountExecutionOrderOut
    from app.domain.lists import ListCustomColumn
    from app.domain.trade import Order, OrderFormField
    from app.settings.lists.export import build_list_csv

    engine, env = migration_0001_db
    with Session(engine) as session:
        session.add(OrderFormField(order_type_code="HS", field_key="legacy_quality_tag", label="历史质量",
                                   field_type="SELECT", options=[{"value": "旧代码", "label": "原质量"}],
                                   is_custom=True, section="PARTICIPANT"))
        session.add(OrderFormField(order_type_code="HS", field_key="legacy_feature_tags", label="历史标签",
                                   field_type="MULTI_SELECT", options=[{"value": "旧甲", "label": "原甲"},
                                                                       {"value": "旧乙", "label": "原乙"}],
                                   is_custom=True, section="PARTICIPANT"))
        session.add(ListCustomColumn(scope="LEDGER", column_key="extra:legacy_quality_tag", label="历史质量",
                                     source_key="legacy_quality_tag", field_type="SELECT",
                                     value_labels={"旧代码": "原质量", "已删代码": "已删原名称",
                                                   "legacy_quality_tag_03": "已删编码名称"}))
        session.add(ListCustomColumn(scope="LEDGER", column_key="extra:legacy_feature_tags", label="历史标签",
                                     source_key="legacy_feature_tags", field_type="MULTI_SELECT",
                                     value_labels={"旧甲": "原甲", "旧乙": "原乙"}))
        session.add(Order(order_no="HS9981", order_type="HS", trade_date=date(2026, 1, 1),
                          form_extra={"legacy_quality_tag": "旧代码", "legacy_feature_tags": ["旧甲", "旧乙"]}))
        session.add(Order(order_no="HS9983", order_type="HS", trade_date=date(2026, 1, 1),
                          form_extra={"legacy_quality_tag": "已删代码"}))
        session.add(Order(order_no="HS9984", order_type="HS", trade_date=date(2026, 1, 1),
                          form_extra={"legacy_quality_tag": "legacy_quality_tag_03"}))
        session.commit()
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE orders DROP COLUMN option_label_snapshot"))

    result = _alembic(env, "upgrade", "head")
    assert result.returncode == 0, result.stdout + result.stderr
    with Session(engine) as session:
        order = session.scalar(select(Order).where(Order.order_no == "HS9981"))
        column = session.scalar(select(ListCustomColumn).where(ListCustomColumn.source_key == "legacy_quality_tag"))
        assert order.form_extra["legacy_quality_tag"] == "legacy_quality_tag_01"
        assert column.value_labels == {"legacy_quality_tag_01": "原质量", "legacy_quality_tag_02": "已删原名称",
                                       "legacy_quality_tag_03": "已删编码名称"}
        exported, _ = build_list_csv(session, "LEDGER", [{"order_no": order.order_no, "form_extra": order.form_extra,
                                                            "option_label_snapshot": order.option_label_snapshot}])
        exported_row = next(csv.DictReader(io.StringIO(exported.lstrip("\ufeff"))))
        assert exported_row["历史质量"] == "原质量"
        assert json.loads(exported_row["历史标签"]) == ["原甲", "原乙"]
        view = AccountExecutionOrderOut(
            order_id=order.id, order_no=order.order_no, order_type=order.order_type,
            trade_date=order.trade_date, created_at=order.created_at, status=order.status,
            operator="-", events=[], option_label_snapshot=order.option_label_snapshot,
            extra_values=order.form_extra,
            extra_fields=[{"key": "legacy_quality_tag", "label": "历史质量", "section": "PARTICIPANT",
                           "value": order.form_extra["legacy_quality_tag"]},
                          {"key": "legacy_feature_tags", "label": "历史标签", "section": "PARTICIPANT",
                           "value": order.form_extra["legacy_feature_tags"]}],
        )
        assert _extras([view])[0].value == "原质量"
        assert _extras([view])[1].value == "原甲、原乙"
        deleted_order = session.scalar(select(Order).where(Order.order_no == "HS9983"))
        assert deleted_order.form_extra["legacy_quality_tag"] == "legacy_quality_tag_02"
        assert deleted_order.option_label_snapshot["legacy_quality_tag"] == "已删原名称"
        from app.business.shared.form_config.form_field_admin_ops.writes import update_order_form_field
        field = session.scalar(select(OrderFormField).where(OrderFormField.field_key == "legacy_quality_tag"))
        update_order_form_field(session, field.id, actor="pytest", options=[
            {"value": "legacy_quality_tag_01", "label": "原质量"}, {"label": "新选项"},
        ])
        assert field.options[-1]["value"] == "legacy_quality_tag_04"


def test_upgrade_0002_finance_import_requires_current_pool_code(migration_0001_db):
    from datetime import date
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from app.business.orders.importing.cashflows import import_cashflows
    from app.business.orders.importing.parser import ImportRow, ImportTable
    from app.core.errors import Validation
    from app.core.security import CurrentUser, ROLE_ADMIN
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order

    engine, env = migration_0001_db
    with Session(engine) as session:
        pool = Pool(code="OLD_POOL", name="原资金账户")
        session.add_all([pool, Order(order_no="HS9982", order_type="HS", trade_date=date(2026, 1, 1))])
        session.flush()
        pool_id = pool.id
        session.commit()
    result = _alembic(env, "upgrade", "head")
    assert result.returncode == 0, result.stdout + result.stderr

    headers = ("订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型")
    values = ("HS9982", "SR09982", "OTHER", "收入", "12.50", "2026-01-01", "OLD_POOL", "OTHER_INCOME", "MANUAL")
    tables = {"cashflows": ImportTable(headers, (ImportRow("资金明细", 2, values),))}
    user = CurrentUser.build(id=1, username="pytest", roles=[ROLE_ADMIN], owner_scope="ALL")
    with Session(engine) as session:
        assert session.get(Pool, pool_id).code == "pool_01"
        with pytest.raises(Validation, match="资金账户不存在或无权使用"):
            import_cashflows(session, tables, [], {"HS9982": "update"}, user)
        values = (*values[:6], "pool_01", *values[7:])
        tables = {"cashflows": ImportTable(headers, (ImportRow("资金明细", 2, values),))}
        assert import_cashflows(session, tables, [], {"HS9982": "update"}, user)[0] == 1
        flow = session.scalar(select(Cashflow).where(Cashflow.flow_no == "SR09982"))
        assert flow.pool_id == pool_id and str(flow.amount) == "12.50"
        assert import_cashflows(session, tables, [], {"HS9982": "update"}, user)[1] == 1
        assert len(session.scalars(select(Cashflow).where(Cashflow.flow_no == "SR09982")).all()) == 1


def test_upgrade_0002_recognizes_previously_migrated_local_data(migration_0001_db):
    from sqlalchemy.orm import Session
    from app.domain.options import OptionSet

    engine, env = migration_0001_db
    with Session(engine) as session:
        session.add_all([OptionSet(code=code, label="已执行", group="SYSTEM", editable=False, options=[],
                                   created_by="pytest", updated_by="pytest") for code in
                         ("DICTIONARY_CODE_MIGRATION_V1", "CONSIGNMENT_CODE_MIGRATION_V1")])
        session.commit()
    with engine.connect() as connection:
        before = connection.scalar(text("SELECT COUNT(*) FROM audit_logs"))
    result = _alembic(env, "upgrade", "head")
    assert result.returncode == 0, result.stdout + result.stderr
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0002"
        assert connection.scalar(text("SELECT COUNT(*) FROM audit_logs")) == before
        assert connection.scalar(text("SELECT COUNT(*) FROM option_sets WHERE code IN ('DICTIONARY_CODE_MIGRATION_V1', 'CONSIGNMENT_CODE_MIGRATION_V1')")) == 0


def test_upgrade_0002_rolls_back_when_legacy_reference_is_invalid(migration_0001_db):
    from sqlalchemy.orm import Session
    from app.business.inventory.profile import create_account

    engine, env = migration_0001_db
    with Session(engine) as session:
        account = create_account(session, game_account="unmapped-migration-test", game_type="不存在的游戏",
                                 business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        session.commit()
        account_id = account.id
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE orders DROP COLUMN option_label_snapshot"))
        connection.execute(text("ALTER TABLE attachments ALTER COLUMN attachment_no SET NOT NULL"))
    result = _alembic(env, "upgrade", "head")
    assert result.returncode != 0
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0001"
        assert connection.scalar(text("SELECT game_type FROM stocks WHERE id=:id"), {"id": account_id}) == "不存在的游戏"
        assert "option_label_snapshot" not in _column_names(engine, "orders")
        assert next(column for column in inspect(connection).get_columns("attachments") if column["name"] == "attachment_no")["nullable"] is False


def test_downgrade_and_upgrade_roundtrip(migration_db, migration_0001_db):
    engine, target, env = migration_db
    blocked = _alembic(env, "downgrade", "0001")
    assert blocked.returncode != 0 and "不能自动降级" in blocked.stderr
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0002"

    baseline_engine, baseline_env = migration_0001_db
    assert _alembic(baseline_env, "downgrade", "base").returncode == 0

    with baseline_engine.connect() as connection:
        remaining = set(inspect(connection).get_table_names())
        assert remaining == {"alembic_version"}

    upgraded = _alembic(baseline_env, "upgrade", "head")
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr


def test_orders_status_check_dropped_draft(migration_db):
    """当前基线产出的 orders CHECK 必须与订单状态枚举一致且不含 DRAFT。

    双向断言的原因：`alembic check` 不校验 CHECK 内容，删/加枚举值若漏了迁移它照样报绿。
    ① 当前 OrderStatus 全部可写入 → 防止以后加枚举值却忘了重建表；
    ② 'DRAFT' 必须被 CHECK 拒绝 → 防止旧状态重新进入基线。
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


def test_account_status_constraint_keeps_inventory_status_independent(migration_db):
    """账号状态 CHECK 含 WAITING 而不含 IN_STOCK，库存状态保留独立列。"""
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
