"""当前 v1 ORM schema 的唯一活动基线。

历史增量迁移保留在 ``alembic/versions`` 供追溯，但不再参与新库升级。
基线直接使用 SQLAlchemy metadata，避免旧 SQLite 专用 DDL（如 DATETIME）污染
PostgreSQL 初始化。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy.orm import Session

from app.core.database import Base
from app.domain import (  # noqa: F401
    attachments,
    foundation,
    imports,
    lists,
    notifications,
    options,
    parties,
    quality,
    trade,
    users,
)
from app.foundation.seeds import seed_foundation
from app.foundation.catalog_seed import seed_catalog


revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)
    with Session(bind=bind) as session:
        seed_foundation(session, actor="system")
        seed_catalog(session, actor="system")
        session.commit()


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
