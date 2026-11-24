"""MASTER-01 游戏类型标准主数据：配置、默认值与业务表单读取契约。"""
from __future__ import annotations

import pytest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

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
    """渠道地区入库前要去空、去重，且顺序按首次出现。"""
    item = list_game_types(seeded_db)[1]

    updated = update_game_type(
        seeded_db, item.id, actor="pytest", channel_regions=["安卓", "iOS", "  ", "安卓"]
    )

    assert updated.channel_regions == ["安卓", "iOS"]
    audit = seeded_db.scalar(select(AuditLog).where(AuditLog.action == "GAME_TYPE_UPDATE", AuditLog.entity_id == str(item.id)).order_by(AuditLog.id.desc()))
    assert audit.after_json["channel_regions"] == ["安卓", "iOS"]


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
