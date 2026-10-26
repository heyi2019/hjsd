"""core.database：v1 独立库 engine / session / Base。

约束：
- v1 库地址只来自 `core.settings`；
- SQLite 显式开启外键约束（SQLite 默认关闭，级联删除会静默失效）；
- 统一约束命名，保证 Alembic 在 SQLite / PostgreSQL 上都能正确迁移。
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from sqlalchemy import MetaData, create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.settings import Settings, get_settings

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """全部领域模型的基类。"""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def _sqlite_connect_args() -> dict[str, Any]:
    return {"check_same_thread": False}


def build_engine(url: str | None = None, *, echo: bool = False) -> Engine:
    """按 URL 构建 engine；SQLite 走 check_same_thread=False。"""
    settings = get_settings()
    target = url or settings.sqlalchemy_url
    kwargs: dict[str, Any] = {"future": True, "echo": echo}
    if target.startswith("sqlite"):
        kwargs["connect_args"] = _sqlite_connect_args()
    else:
        kwargs["pool_pre_ping"] = True
    return create_engine(target, **kwargs)


@event.listens_for(Engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection: Any, connection_record: Any) -> None:
    """SQLite 连接级 PRAGMA：外键 + WAL。

    - 外键默认关闭，不开启会导致 cascade 失效、脏行留存；
    - journal_mode 默认 delete（读写互斥），改 WAL 后读不阻塞写、写不阻塞读。
      该设置持久化在库头，此处每次连接再声明一次，保证新建库/临时库同样生效。
    """
    if dbapi_connection.__class__.__module__ not in {"sqlite3", "pysqlite2.dbapi2"}:
        return
    try:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()
    except Exception:  # pragma: no cover - 非 SQLite 方言直接忽略
        pass


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def get_engine(url: str | None = None) -> Engine:
    """进程级 engine 单例；测试通过 reset_engine(url) 切到临时库。"""
    global _engine
    if url is not None:
        return build_engine(url)
    if _engine is None:
        _engine = build_engine()
    return _engine


def reset_engine(url: str | None = None) -> Engine:
    """重建 engine 并丢弃旧连接池（测试/迁移后使用）。"""
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = build_engine(url)
    _session_factory = None
    return _engine


def get_session_factory(url: str | None = None) -> sessionmaker[Session]:
    global _session_factory
    if url is not None:
        return sessionmaker(bind=build_engine(url), autoflush=False, autocommit=False)
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


def create_all(url: str | None = None) -> Engine:
    """仅供测试快速建库；生产结构一律走 Alembic。"""
    engine = get_engine(url)
    Base.metadata.create_all(bind=engine)
    return engine


def dispose_engine() -> None:
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None


def describe_engine(settings: Settings | None = None) -> dict[str, str]:
    settings = settings or get_settings()
    info = settings.describe()
    sqlite_file = settings.sqlite_file
    info["sqlite_exists"] = str(bool(sqlite_file and sqlite_file.exists()))
    return info


__all__ = [
    "Base",
    "NAMING_CONVENTION",
    "build_engine",
    "create_all",
    "describe_engine",
    "dispose_engine",
    "get_db",
    "get_engine",
    "get_session_factory",
    "reset_engine",
]
