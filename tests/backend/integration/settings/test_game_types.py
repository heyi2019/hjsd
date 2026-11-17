"""MASTER-01 游戏类型标准主数据：配置、默认值与业务表单读取契约。"""
from __future__ import annotations

import pytest

from app.core.errors import Validation
from app.field_definitions.game_types import (
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
