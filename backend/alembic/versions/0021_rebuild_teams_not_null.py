"""rebuild_teams_not_null：重建 teams 表补回 id 的 NOT NULL 声明。

背景：正式库 `teams` 是早期整表重建的产物，id 被建成
`id INTEGER PRIMARY KEY AUTOINCREMENT`，SQLite 对 rowid 别名主键在
`PRAGMA table_info` 里报 `notnull=0`；而从 0001 迁移链新建的库是
`id INTEGER NOT NULL … CONSTRAINT pk_teams PRIMARY KEY (id)`（notnull=1）。
两者模型侧都是 `Mapped[int] = mapped_column(primary_key=True)`（nullable=False），
于是 `alembic check` 在正式库上恒报 `modify_nullable teams.id`——门禁变红会
掩盖真正的结构漂移。

本次按新建库的形态整表重建（SQLite 不支持 ALTER COLUMN）。表内仅 1 行，
且**没有任何表以 FK 引用 teams**（`users.team_ids` 是 JSON 数组，不是外键），
重建无级联风险。

幂等：先查 `PRAGMA table_info(teams)` 的 id notnull，已是 1 则跳过；
表不存在（裁剪库）也跳过。

Revision ID: fad42e66db1a
Revises: 6caeeacd7625
Create Date: 2026-10-27 13:30:00.000000

"""
from __future__ import annotations

from alembic import op
from sqlalchemy.engine import Connection

revision: str = "fad42e66db1a"
down_revision: str | None = "6caeeacd7625"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "teams"
TMP = "teams__rebuild"

COLUMNS = "id, code, name, description, is_active, created_at, updated_at"

# 目标形态 = 0001 迁移链在全新库建出来的样子（pk 命名约束 + id NOT NULL）
_TARGET_DDL = f"""
CREATE TABLE {TMP} (
    id INTEGER NOT NULL,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT 1 NOT NULL,
    created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    CONSTRAINT pk_teams PRIMARY KEY (id),
    CONSTRAINT uq_teams_code UNIQUE (code)
)
"""

# downgrade 用：还原成正式库原有形态（AUTOINCREMENT 主键）
_LEGACY_DDL = f"""
CREATE TABLE {TMP} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_teams_code UNIQUE (code)
)
"""


def _table_exists(bind: Connection) -> bool:
    row = bind.exec_driver_sql(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (TABLE,)
    ).first()
    return row is not None


def _id_not_null(bind: Connection) -> bool:
    for row in bind.exec_driver_sql(f"PRAGMA table_info({TABLE})").fetchall():
        # PRAGMA table_info: cid, name, type, notnull, dflt_value, pk
        if row[1] == "id":
            return bool(row[3])
    return False


def _rebuild(ddl: str) -> None:
    bind = op.get_bind()
    if not _table_exists(bind):
        return
    op.execute(f"DROP TABLE IF EXISTS {TMP}")
    op.execute(ddl)
    op.execute(f"INSERT INTO {TMP} ({COLUMNS}) SELECT {COLUMNS} FROM {TABLE}")
    op.execute(f"DROP TABLE {TABLE}")
    op.execute(f"ALTER TABLE {TMP} RENAME TO {TABLE}")


def upgrade() -> None:
    if _id_not_null(op.get_bind()):
        return
    _rebuild(_TARGET_DDL)


def downgrade() -> None:
    if not _id_not_null(op.get_bind()):
        return
    _rebuild(_LEGACY_DDL)
