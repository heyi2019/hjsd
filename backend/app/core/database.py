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


def _sqlite_optimize_on_checkin(dbapi_connection: Any, _record: Any) -> None:
    """连接归还池时执行 `PRAGMA optimize`，让统计信息自我维护。

    `sqlite_stat1` 只在手工 ANALYZE 后存在，数据涨了就失真、查询计划退化——
    而 optimize 是 SQLite 官方的统计维护入口：绝大多数时候只是几百条指令的
    快速检查，判定需要时才对**确实变化大的表**做受限 ANALYZE。挂在 checkin
    而不是 close，是因为池化连接不 close；同一条连接做完工作归还时正是
    官方文档建议的执行点。失败静默：它只是锦上添花，不能拖垮请求。
    """
    try:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA optimize")
        cursor.close()
    except Exception:  # pragma: no cover - 统计维护失败不影响业务
        pass


def build_engine(url: str | None = None, *, echo: bool = False) -> Engine:
    """按 URL 构建 engine；SQLite 走 check_same_thread=False + 连接归还自动 optimize。"""
    settings = get_settings()
    target = url or settings.sqlalchemy_url
    kwargs: dict[str, Any] = {"future": True, "echo": echo}
    if target.startswith("sqlite"):
        kwargs["connect_args"] = _sqlite_connect_args()
        engine = create_engine(target, **kwargs)
        event.listens_for(engine.pool, "checkin")(_sqlite_optimize_on_checkin)
        return engine
    kwargs["pool_pre_ping"] = True
    return create_engine(target, **kwargs)


def _sqlite_pragma_statements(settings: Settings | None = None) -> list[str]:
    """连接级 PRAGMA 清单（顺序敏感：journal_mode 必须在 synchronous 之前）。

    参数全部来自 `core.settings`，可按环境覆盖；`0` 表示不改该项、沿用 SQLite 默认。
    """
    cfg = settings or get_settings()
    statements = [
        # 外键默认关闭，不开启会导致 cascade 失效、脏行留存。
        "PRAGMA foreign_keys=ON",
        # delete 模式下读写互斥；WAL 下读不阻塞写、写不阻塞读。
        "PRAGMA journal_mode=WAL",
        # 必须在设 WAL 之后：切日志模式本身会重置该连接的回滚日志强度。
        f"PRAGMA synchronous={cfg.sqlite_synchronous}",
        f"PRAGMA temp_store={cfg.sqlite_temp_store}",
    ]
    if cfg.sqlite_cache_size_kb > 0:
        # SQLite 负值表示 KB（正值是页数，会随 page_size 变化，不直观）。
        statements.append(f"PRAGMA cache_size=-{cfg.sqlite_cache_size_kb}")
    if cfg.sqlite_mmap_size_mb > 0:
        statements.append(f"PRAGMA mmap_size={cfg.sqlite_mmap_size_mb * 1024 * 1024}")
    return statements


@event.listens_for(Engine, "connect")
def _apply_sqlite_pragmas(dbapi_connection: Any, connection_record: Any) -> None:
    """SQLite 连接级 PRAGMA：外键、WAL 与运行参数。

    这些 PRAGMA 大多是**连接级**的（除 journal_mode 持久化在库头），
    因此必须挂在 connect 事件上，池中每新建一条连接都要重新声明。
    测试库会在自己的引擎上再挂一个监听覆盖本函数（见 tests/v1/conftest.py），
    以 OFF/MEMORY 换取跑测速度——两者不冲突，后注册者生效。
    """
    if dbapi_connection.__class__.__module__ not in {"sqlite3", "pysqlite2.dbapi2"}:
        return
    try:
        cursor = dbapi_connection.cursor()
        for statement in _sqlite_pragma_statements():
            cursor.execute(statement)
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
