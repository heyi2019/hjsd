"""MASTER-01 游戏类型标准主数据：配置、默认值与业务表单读取契约。"""
from __future__ import annotations

import pytest
from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from threading import Event
from uuid import uuid4
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import Session
import _repo

from app.core.errors import Validation
from app.domain.foundation import AuditLog, GameTypeOption
from app.domain.base import Base
from app.settings.field_definitions.game_types import (
    create_game_type,
    delete_game_type,
    list_game_types,
    set_game_type_active,
    set_game_type_default,
    update_game_type,
)


def _dictionary_migration():
    path = _repo.BACKEND_DIR / "alembic" / "squashed_versions" / "0002_dictionary_codes.py"
    spec = spec_from_file_location("dictionary_migration_0002", path)
    assert spec and spec.loader
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_seeded_game_types_include_one_default(seeded_db):
    items = list_game_types(seeded_db)

    assert [item.name for item in items] == ["王者荣耀", "原神"]
    assert [item.name for item in items if item.is_default] == ["王者荣耀"]


def test_setting_default_clears_previous_default(seeded_db):
    items = list_game_types(seeded_db)

    set_game_type_default(seeded_db, items[1].id, True, actor="pytest")
    seeded_db.commit()

    assert [item.name for item in list_game_types(seeded_db) if item.is_default] == ["原神"]


def test_cannot_disable_default_game_type(seeded_db):
    item = list_game_types(seeded_db)[0]

    with pytest.raises(Validation, match="默认游戏类型"):
        set_game_type_active(seeded_db, item.id, False, actor="pytest")


def test_duplicate_game_type_is_rejected(seeded_db):
    with pytest.raises(Validation, match="游戏类型已存在"):
        create_game_type(seeded_db, name="王者荣耀", actor="pytest")


def test_delete_default_game_type_is_rejected(seeded_db):
    """默认游戏类型是业务表单的兜底，删除会让录单失去默认值 —— 必须拒绝。"""
    item = list_game_types(seeded_db)[0]
    assert item.is_default

    with pytest.raises(Validation, match="默认游戏类型不能删除"):
        delete_game_type(seeded_db, item.id, actor="pytest")


def test_update_game_type_writes_channel_regions(seeded_db):
    """渠道名称去空格，保存自动分配的稳定编码并记审计。"""
    item = list_game_types(seeded_db)[1]

    updated = update_game_type(
        seeded_db, item.id, actor="pytest", channel_regions=[{"label": " 安卓 "}, {"label": "iOS"}]
    )

    expected = [{"value": "channel_01", "label": "安卓"}, {"value": "channel_02", "label": "iOS"}]
    assert updated.channel_regions == expected
    audit = seeded_db.scalar(select(AuditLog).where(AuditLog.action == "GAME_TYPE_UPDATE", AuditLog.entity_id == str(item.id)).order_by(AuditLog.id.desc()))
    assert audit.after_json["channel_regions"] == expected


def test_game_type_delete_is_an_enumerated_audited_action(seeded_db):
    from app.domain.enums import AuditAction
    from app.domain.options import OptionSet
    from app.settings.field_definitions.catalog_seed import seed_catalog
    item = list_game_types(seeded_db)[1]
    item_id = item.id
    delete_game_type(seeded_db, item_id, actor="pytest")
    assert AuditAction.GAME_TYPE_DELETE.value == "GAME_TYPE_DELETE"
    log = seeded_db.scalar(select(AuditLog).where(AuditLog.action == AuditAction.GAME_TYPE_DELETE.value, AuditLog.entity_id == str(item_id)))
    assert log.before_json["name"] == "原神"
    seed_catalog(seeded_db)
    options = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "AUDIT_ACTION"))
    assert any(option["value"] == "GAME_TYPE_DELETE" and option["label"] == "删除游戏类型" for option in options.options)


def test_removed_game_and_channel_keep_historical_labels(seeded_db):
    from app.shared.game_references import game_reference_labels
    game = create_game_type(seeded_db, name="历史游戏", actor="pytest", channel_regions=[{"label": "历史渠道"}])
    game_value = game.value
    channel_value = game.channel_regions[0]["value"]
    delete_game_type(seeded_db, game.id, actor="pytest")
    seeded_db.flush()
    games, channels = game_reference_labels(seeded_db)
    assert games[game_value] == "历史游戏"
    assert channels[channel_value] == "历史渠道"


def test_one_step_encoding_migration_preserves_existing_orders(seeded_db):
    from datetime import date
    from app.domain.options import OptionSet
    from app.business.inventory.profile import create_account
    from app.business.orders.create import create_order
    from app.settings.field_definitions.catalog_seed import seed_catalog
    from scripts.test_example_seed import seed_example_catalog

    migration = _dictionary_migration()
    seed_catalog(seeded_db, actor="pytest")
    seed_example_catalog(seeded_db)
    game = list_game_types(seeded_db)[0]
    account = create_account(seeded_db, game_account="legacy-migration", game_type=game.name,
                             channel_region="安卓QQ", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 1, 1), actor="pytest",
                         account_id=account.id, form_extra={"business_responsible_ids": [1], "intermediary_type": "包赔"})
    account.wallet_realname = "未注销"
    order.account_snapshot = {"game_account": account.game_account, "game_type": game.name,
                              "channel_region": "安卓QQ", "wallet_realname": "未注销"}
    game.channel_regions = ["安卓QQ"]
    dictionary = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "INTERMEDIARY_TYPE"))
    dictionary.options = [{"value": "普中", "label": "普中"}, {"value": "包赔", "label": "包赔"}]
    seeded_db.flush()

    migration.migrate_codes(seeded_db, actor="pytest")
    assert account.game_type == game.value
    assert account.channel_region == "channel_01"
    assert account.wallet_realname == "N"
    assert order.account_snapshot["game_type_label"] == "王者荣耀"
    assert order.account_snapshot["channel_region_label"] == "安卓QQ"
    assert order.form_extra["intermediary_type"] == "intermediary_type_02"
    assert order.option_label_snapshot["intermediary_type"] == "包赔"


def test_encoding_migration_rolls_back_if_game_cannot_be_matched(seeded_db):
    from app.business.inventory.profile import create_account
    migration = _dictionary_migration()
    account = create_account(seeded_db, game_account="ambiguous-migration", game_type="未配置的游戏",
                             business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    game = list_game_types(seeded_db)[0]
    game.channel_regions = ["安卓QQ"]
    seeded_db.flush()
    with pytest.raises(Validation, match="游戏类型"):
        migration.migrate_codes(seeded_db, actor="pytest")
    seeded_db.refresh(account)
    seeded_db.refresh(game)
    assert account.game_type == "未配置的游戏"
    assert game.channel_regions == ["安卓QQ"]


def test_encoding_migration_archives_unconfigured_channel_and_preserves_financial_ids(seeded_db):
    from datetime import date
    from app.business.inventory.profile import create_account
    from app.business.orders.create import create_order
    from app.domain.foundation import Pool
    from app.domain.users import Team
    from app.finance.cashflow.cashflows import create_cashflow
    from app.shared.game_references import game_reference_labels
    migrate_codes = _dictionary_migration().migrate_codes

    game = list_game_types(seeded_db)[0]
    account = create_account(seeded_db, game_account="legacy-unlisted-channel", game_type=game.name,
                             channel_region="旧渠道", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 1, 1), actor="pytest", account_id=account.id)
    order.account_snapshot = {"game_type": game.name, "channel_region": "旧渠道"}
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "pool_01"))
    pool_id = pool.id
    pool.code = "HJ_INVEST"
    team = Team(code="OLD_TEAM", name="老团队", is_active=True)
    seeded_db.add(team)
    flow = create_cashflow(seeded_db, pool_id=pool_id, occurred_on=date(2026, 1, 1), direction="IN",
                           category="OTHER", amount="123.45", actor="pytest")
    flow_id, team_id = flow.id, team.id
    game.channel_regions = ["安卓QQ"]
    seeded_db.flush()
    seeded_db.execute(text("ALTER TABLE orders DROP COLUMN option_label_snapshot"))

    migrate_codes(seeded_db, actor="pytest")
    seeded_db.refresh(account)
    seeded_db.refresh(order)
    seeded_db.refresh(flow)
    seeded_db.refresh(pool)
    seeded_db.refresh(team)
    _, channels = game_reference_labels(seeded_db)
    assert channels[account.channel_region] == "旧渠道"
    assert all(item["label"] != "旧渠道" for item in game.channel_regions)
    assert order.account_snapshot["channel_region_label"] == "旧渠道"
    assert flow.id == flow_id and flow.pool_id == pool_id and str(flow.amount) == "123.45"
    assert pool.id == pool_id and pool.code == "pool_01"
    assert team.id == team_id and team.code == "team_01"


def test_encoding_migration_preserves_consignment_listing_state(seeded_db):
    from datetime import date
    from app.business.orders.create import create_order
    from app.business.shared.listing_state import active_listings
    from app.domain.options import OptionSet
    from app.domain.trade import OrderEvent
    from app.settings.field_definitions.catalog_seed import seed_catalog
    from scripts.test_example_seed import seed_example_catalog
    migrate_codes = _dictionary_migration().migrate_codes

    seed_catalog(seeded_db, actor="pytest")
    seed_example_catalog(seeded_db)
    platforms = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "INTERMEDIARY_PLATFORM"))
    platforms.options = [{"value": "千寻", "label": "千寻"}, {"value": "盼之", "label": "盼之"}, {"value": "螃蟹", "label": "螃蟹"}]
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 1, 1), actor="pytest",
                         form_extra={"business_responsible_ids": [1]})
    listing = OrderEvent(order_id=order.id, event_no="TEST-LIST", event_type="OPERATE", amount=0,
                         occurred_on=date(2026, 1, 1), is_posted=True, created_by="pytest", updated_by="pytest",
                         form_extra={"operation_type": "CONSIGNMENT", "consignment_platforms": ["千寻", "盼之"]})
    seeded_db.add(listing)
    seeded_db.flush()
    unlisting = OrderEvent(order_id=order.id, event_no="TEST-UNLIST", event_type="OPERATE", amount=0,
                           occurred_on=date(2026, 1, 2), is_posted=True, created_by="pytest", updated_by="pytest",
                           form_extra={"operation_type": "UNLIST", "consignment_event_id": listing.id,
                                       "platform_unlist_scope": "PLATFORM", "consignment_platforms": ["千寻"]})
    seeded_db.add(unlisting)
    seeded_db.flush()
    assert active_listings(seeded_db, order.id) == {(listing.id, "盼之")}

    migrate_codes(seeded_db, actor="pytest")
    seeded_db.refresh(listing)
    seeded_db.refresh(unlisting)
    assert listing.form_extra["consignment_platforms"] == ["intermediary_platform_01", "intermediary_platform_02"]
    assert unlisting.form_extra["consignment_platforms"] == ["intermediary_platform_01"]
    assert listing.form_extra["consignment_platform_labels"]["intermediary_platform_02"] == "盼之"
    assert active_listings(seeded_db, order.id) == {(listing.id, "intermediary_platform_02")}


@pytest.fixture
def concurrent_game_engine(v1_engine):
    schema = f"game_type_race_{uuid4().hex[:12]}"
    with v1_engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(v1_engine.url, connect_args={"options": f"-c search_path={schema}"})
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as session:
            session.add_all([
                GameTypeOption(name="默认游戏", is_active=True, is_default=True, created_by="pytest", updated_by="pytest"),
                GameTypeOption(name="另一个游戏", is_active=True, is_default=False, created_by="pytest", updated_by="pytest"),
            ])
            session.commit()
        yield engine
    finally:
        engine.dispose()
        with v1_engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_default_change_serializes_competing_disable_or_delete(concurrent_game_engine, operation):
    engine = concurrent_game_engine
    target_id = 2
    ready, start, attempted = Event(), Event(), Event()

    def competing_write():
        with Session(engine) as session:
            stale = session.get(GameTypeOption, target_id)  # 提前载入旧状态，验证等待后会重新检查。
            assert stale is not None and not stale.is_default
            ready.set()
            assert start.wait(10)
            def before(_conn, _cursor, statement, _params, _context, _many):
                sql = statement.lower()
                if "pg_advisory_xact_lock" in sql or ("game_type_options" in sql and ("update " in sql or "delete " in sql)):
                    attempted.set()
            event.listen(session.connection(), "before_cursor_execute", before)
            try:
                if operation == "disable":
                    set_game_type_active(session, target_id, False, actor="pytest")
                else:
                    delete_game_type(session, target_id, actor="pytest")
                session.commit()
                return "accepted"
            except Validation:
                session.rollback()
                return "rejected"

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(competing_write)
        assert ready.wait(10)
        with Session(engine) as first:
            set_game_type_default(first, target_id, True, actor="pytest")
            start.set()
            assert attempted.wait(10)
            assert not future.done()
            first.commit()
        assert future.result(timeout=10) == "rejected"
    with Session(engine) as session:
        target = session.get(GameTypeOption, target_id)
        assert target is not None and target.is_active and target.is_default


def test_competing_game_type_creation_returns_duplicate_error(concurrent_game_engine):
    engine = concurrent_game_engine
    start, attempted = Event(), Event()

    def create_again():
        with Session(engine) as session:
            assert start.wait(10)
            def before(_conn, _cursor, statement, _params, _context, _many):
                sql = statement.lower()
                if "pg_advisory_xact_lock" in sql or ("insert into game_type_options" in sql):
                    attempted.set()
            event.listen(session.connection(), "before_cursor_execute", before)
            try:
                create_game_type(session, name="并发游戏", actor="pytest")
                session.commit()
                return None
            except Exception as exc:
                session.rollback()
                return type(exc)

    with ThreadPoolExecutor(max_workers=1) as executor, Session(engine) as first:
        future = executor.submit(create_again)
        create_game_type(first, name="并发游戏", actor="pytest")
        start.set()
        assert attempted.wait(10)
        assert not future.done()
        first.commit()
        assert future.result(timeout=10) is Validation
