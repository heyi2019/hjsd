"""core 基础设施补充覆盖：engine 生命周期、JWT payload 全分支。

补齐 coverage 缺口：
- core/database.py:81  reset_engine 已建 engine 时触发 _engine.dispose()
- core/security.py:336/345/351/353  user_from_payload 四种非法 payload → AuthError
"""
from __future__ import annotations

import pytest

from app.core import database
from app.core.security import AuthError, user_from_payload


def test_reset_engine_disposes_existing():
    # 先建立 engine，再 reset 触发 _engine.dispose() 分支（database.py:81）
    engine = database.get_engine()
    assert engine is not None
    new_engine = database.reset_engine()
    assert new_engine is not None
    # 复位后全局 engine 为新建实例，后续 fixture 复用同一 DB URL
    assert database.get_engine() is new_engine


def test_user_from_payload_rejects_bool_sub():
    # security.py:336  sub 为 bool 时拒绝
    with pytest.raises(AuthError):
        user_from_payload({"sub": True, "username": "x"})


def test_user_from_payload_rejects_nonpositive_or_empty_username():
    # security.py:345  user_id<=0 或 username 非法
    with pytest.raises(AuthError):
        user_from_payload({"sub": 0, "username": "x"})
    with pytest.raises(AuthError):
        user_from_payload({"sub": 1, "username": "  "})


def test_user_from_payload_rejects_bad_scope_claims():
    # security.py:351  pool_ids/team_ids 含非正 int / 非 int / bool
    with pytest.raises(AuthError):
        user_from_payload({"sub": 1, "username": "x", "pool_ids": [1, "bad"]})


def test_user_from_payload_rejects_invalid_owner_scope():
    # security.py:353  owner_scope 不在 OWNER_SCOPES
    with pytest.raises(AuthError):
        user_from_payload({"sub": 1, "username": "x", "owner_scope": "INVALID"})
