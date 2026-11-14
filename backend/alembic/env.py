"""Alembic 环境：URL 与 models 都由 v1 代码提供。

用法（工作目录 backend）：
```bash
DATABASE_URL=postgresql+psycopg://erp_app@127.0.0.1:5432/heijin_erp_dev alembic upgrade head
```
禁止把 `sqlalchemy.url` 写进 alembic.ini：那会产生第二个配置真相，
导致迁移跑到旧 `heijin.db` 上（PRD V15/V17）。
"""
from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool, event, text

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import Base  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain import attachments, foundation, imports, lists, notifications, options, parties, trade, users  # noqa: E402,F401  注册全部 v1 模型

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
# Alembic 会对 URL 做 ConfigParser 插值，百分号需转义
config.set_main_option("sqlalchemy.url", settings.alembic_url.replace("%", "%%"))

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """生成 SQL 脚本（不连接数据库）。"""
    context.configure(
        url=settings.alembic_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """连接数据库执行迁移。"""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    if settings.alembic_url.startswith("postgresql"):
        # Alembic 默认把 version_num 建成 VARCHAR(32)，但正式迁移 revision
        # `0065_allow_split_cashflow_per_event` 已超过 32 字符。先在独立事务
        # 中创建/扩容版本表，确保新库和存量 PostgreSQL 都能写入版本戳。
        with connectable.begin() as bootstrap:
            bootstrap.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS alembic_version "
                    "(version_num VARCHAR(64) NOT NULL)"
                )
            )
            bootstrap.execute(
                text(
                    "ALTER TABLE alembic_version "
                    "ALTER COLUMN version_num TYPE VARCHAR(64)"
                )
            )
    # 覆盖 database.py 的全局 connect 监听：SQLite 的 batch 重建父表（orders）
    # 需临时关闭外键。PostgreSQL 不认识 PRAGMA，不能注册这条监听。
    if settings.alembic_url.startswith("sqlite"):
        event.listen(connectable, "connect", lambda c, p: c.execute("PRAGMA foreign_keys=OFF"))
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=settings.alembic_url.startswith("sqlite"),
            compare_type=True,
            transactional_ddl=True,  # 由 Alembic 统一 COMMIT，避免 DDL/版本戳在连接关闭时静默回滚
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
