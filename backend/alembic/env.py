"""Alembic 环境：URL 与 models 都由 v1 代码提供。

用法（工作目录 backend）：
```bash
DATABASE_URL=sqlite:///./data/heijin_erp_v1.db alembic upgrade head
```
禁止把 `sqlalchemy.url` 写进 alembic.ini：那会产生第二个配置真相，
导致迁移跑到旧 `heijin.db` 上（PRD V15/V17）。
"""
from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool, text, event
from sqlalchemy import Engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import Base  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain import foundation, history, notifications, parties, quality, trade, users  # noqa: E402,F401  注册全部 v1 模型

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
    # 覆盖 database.py 的全局 connect 监听：该监听会在每次连接时强制 `PRAGMA foreign_keys=ON`，
    # 而 SQLite 的 batch 重建父表（orders）需 DROP 原表，FK 开启会因子表引用而失败。
    # 这里在引擎实例上注册 FK=OFF 监听，注册顺序晚于 database.py 的类级监听，故 OFF 在其后生效；
    # 且对任意新建连接（含 batch 重建可能开启的子连接）都生效。
    # 注意：`PRAGMA foreign_keys` 在事务内是 no-op，所以必须保留 transactional_ddl=True，
    # 由 Alembic 在外层事务结束时统一 COMMIT（否则约束写入与版本戳会在连接关闭时被静默回滚）。
    event.listen(connectable, "connect", lambda c, p: c.execute("PRAGMA foreign_keys=OFF"))
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite 结构性变更需要 batch 模式
            compare_type=True,
            transactional_ddl=True,  # 由 Alembic 统一 COMMIT，避免 DDL/版本戳在连接关闭时静默回滚
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
