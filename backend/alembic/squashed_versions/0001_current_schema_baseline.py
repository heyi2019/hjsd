"""当前 v1 ORM schema 的唯一活动基线（2026-11-02 压平后的唯一活动迁移）。

压平口径：
- **schema 随 ORM 走**：直接 `Base.metadata.create_all()`，改模型即改基线，不再加增量 DDL 迁移；
- **种子随 blob 走**：`option_sets` / `order_form_fields` 由 `app.foundation.catalog_seed`
  的内嵌 base64+zlib blob 提供，新增内置字段要更新 blob，而不是再加一条 seed 迁移；
- 原 0002~0013（加列、列改名、时间戳归一、四次 seed）已并入基线并删除，
  追溯见 git 历史与 ``alembic/versions``（后者只存档、不参与加载）；
- 既有库（版本戳还是旧 revision）**必须先对齐**：``alembic stamp --purge 0001``；
  空库直接 ``alembic upgrade head``。

旧 SQLite 专用 DDL（如 DATETIME）不进基线，避免污染 PostgreSQL 初始化。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy.orm import Session

from app.core.database import Base
from app.domain import (  # noqa: F401
    attachments,
    foundation,
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
