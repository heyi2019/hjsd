"""CORE-01 core 基础设施补充覆盖：engine 生命周期、跨方言函数、编号生成、限流窗口。

补齐 coverage 缺口：
- core/database.py:55/74      get_engine/get_session_factory 的「显式 url」分支
- core/database.py:103-105    create_all 测试建库入口
- core/database.py:110-113    dispose_engine 必须把两个全局单例都置空
- core/ratelimit.py:30        窗口过期后计数归零（不是永久封禁）
- core/sql_functions.py:30/31 sqlite 方言的 strftime 渲染

本文件属 `unit` 组（单文件 <1s、不依赖 seeded_db/TestClient）。
返点分次结算编号 `rebate_settlement_no` 随模型层下线已删除，相关用例一并移除。
"""
from __future__ import annotations

import pytest
from sqlalchemy import column, inspect, select, text
from sqlalchemy.dialects import postgresql, sqlite

from app.core import database
from app.core.ratelimit import RateLimiter
from app.core.security import AuthError, user_from_payload
from app.core.sql_functions import year_month


def test_reset_engine_disposes_existing():
    # 先建立 engine，再 reset 触发 _engine.dispose() 分支（database.py:81）
    engine = database.get_engine()
    assert engine is not None
    new_engine = database.reset_engine()
    assert new_engine is not None
    # 复位后全局 engine 为新建实例，后续 fixture 复用同一 DB URL
    assert database.get_engine() is new_engine


def test_get_engine_builds_engine_for_explicit_url(v1_engine):
    """显式 url 时不写全局单例，直接返回一个能连上的新 engine。"""
    engine = database.get_engine(v1_engine.url)
    try:
        assert engine is not database._engine
        with engine.connect() as connection:
            assert connection.scalar(text("select 1")) == 1
    finally:
        engine.dispose()


def test_get_session_factory_builds_for_explicit_url(v1_engine):
    """显式 url 时新建工厂，且不把进程级 _session_factory 一起改掉。"""
    factory = database.get_session_factory(v1_engine.url)
    assert database._session_factory is None
    session = factory()
    try:
        assert session.get_bind().url.database == v1_engine.url.database
    finally:
        session.close()


def test_create_all_is_idempotent_on_existing_schema(v1_engine):
    """测试建库入口：对已建好的 schema 重复执行不报错、表仍在。"""
    engine = database.create_all(v1_engine.url)
    try:
        assert inspect(engine).has_table("orders")
    finally:
        engine.dispose()


def test_dispose_engine_clears_singletons(v1_engine):
    """停用后必须把 engine 与工厂都置空，否则残留连接池指向旧库。"""
    database.reset_engine(v1_engine.url)
    assert database._engine is not None

    database.dispose_engine()

    assert database._engine is None
    assert database._session_factory is None


def test_ratelimit_window_expiry_resets_counter(monkeypatch):
    """窗口到期后计数归零：同一 key 在 61s 后重新放行，而不是永久封禁。"""
    ticks = iter([0.0, 0.0, 61.0])
    monkeypatch.setattr("app.core.ratelimit.time.monotonic", lambda: next(ticks))
    limiter = RateLimiter()

    assert limiter.is_allowed("k", limit=1, window_seconds=60) is True
    assert limiter.is_allowed("k", limit=1, window_seconds=60) is False  # 同窗口封顶
    assert limiter.is_allowed("k", limit=1, window_seconds=60) is True  # 窗口过期重置


def test_year_month_compiles_for_both_dialects():
    """按月聚合键必须两边都能渲染：PG 走 to_char，SQLite 走 strftime（已下线方言仍保兼容）。"""
    expression = year_month(column("trade_date"))

    pg_sql = str(select(expression).compile(dialect=postgresql.dialect()))
    sqlite_sql = str(select(expression).compile(dialect=sqlite.dialect()))

    assert "to_char(trade_date, 'YYYY-MM')" in pg_sql
    assert "strftime('%Y-%m', trade_date)" in sqlite_sql


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
    # amr 不在认证方式白名单时同样拒绝：否则伪造 token 可抬高免密会话的信任级。
    with pytest.raises(AuthError):
        user_from_payload({"sub": 1, "username": "x", "amr": "FORGED"})
