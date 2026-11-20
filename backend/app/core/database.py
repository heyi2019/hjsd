"""core.database：v1 独立库 engine / session。

约束：
- v1 库地址只来自 `core.settings`；
- 统一约束命名，保证 Alembic 在 PostgreSQL 上正确迁移。

**Base 归属说明（2026-11-18 架构归位）**：
`Base`（ORM 声明基类）与 `create_all` 已归位到 `app/domain/base.py`。
它们是 ORM 层的东西；留在 core 会让 core 反向依赖 domain，形成
`core ↔ domain` 双向环。本模块现在只做连接与事务，不认识任何模型。

SQLite 通道已下线（2026-11-02）：生产与测试统一 PostgreSQL。原先挂在
`Engine.connect` 上的连接级 PRAGMA、连接归还时的 `PRAGMA optimize`、以及
`check_same_thread` 连接参数一并移除——它们对 PostgreSQL 无任何意义。
"""
from __future__ import annotations

from collections.abc import Iterator
from threading import RLock

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.settings import get_settings


def build_engine(url: str | None = None, *, echo: bool = False) -> Engine:
    """按 URL 构建 engine。

    `pool_pre_ping=True`：连接池里的连接可能已被服务端（或中间代理）断开，
    取用前先探活，避免首个请求报 `server closed the connection unexpectedly`。
    """
    settings = get_settings()
    target = url or settings.alembic_url
    return create_engine(target, future=True, echo=echo, pool_pre_ping=True)


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None
_engine_lock = RLock()


def get_engine(url: str | None = None) -> Engine:
    """进程级 engine 单例；测试通过 reset_engine(url) 切到临时库。"""
    global _engine
    if url is not None:
        return build_engine(url)
    with _engine_lock:
        if _engine is None:
            _engine = build_engine()
        return _engine


def reset_engine(url: str | None = None) -> Engine:
    """重建 engine 并丢弃旧连接池（测试/迁移后使用）。"""
    global _engine, _session_factory
    with _engine_lock:
        if _engine is not None:
            _engine.dispose()
        _engine = build_engine(url)
        _session_factory = None
        return _engine


def get_session_factory(url: str | None = None) -> sessionmaker[Session]:
    global _session_factory
    if url is not None:
        return sessionmaker(bind=build_engine(url), autoflush=False, autocommit=False)
    with _engine_lock:
        if _session_factory is None:
            _session_factory = sessionmaker(
                bind=get_engine(), autoflush=False, autocommit=False, future=True
            )
        return _session_factory


def get_db() -> Iterator[Session]:
    """FastAPI 依赖：一次请求一个会话。

    写路径纪律：Service 负责业务逻辑与审计落盘，**提交在请求边界统一完成**——
    请求正常结束则提交，抛异常则回滚。这样保证「业务 + 审计」要么同时可见，要么同时消失，
    不会出现已返回 201 但数据并未落库的假成功（2026-10-04 实测修复）。
    """
    SessionFactory = get_session_factory()
    db = SessionFactory()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def dispose_engine() -> None:
    global _engine, _session_factory
    with _engine_lock:
        if _engine is not None:
            _engine.dispose()
        _engine = None
        _session_factory = None


def describe_engine() -> dict[str, str]:
    """健康检查/排障用：不泄露密钥原文。"""
    return get_settings().describe()


__all__ = [
    "build_engine",
    "describe_engine",
    "dispose_engine",
    "get_db",
    "get_engine",
    "get_session_factory",
    "reset_engine",
]
