"""当前 v1 ORM schema 的唯一活动基线（2026-11-02 压平后的唯一活动迁移）。

压平口径：
- **基线 schema 随 ORM 走**：直接 `Base.metadata.create_all()` 建立压平时的 schema；后续需要保留数据的结构变化使用版本化 DDL 迁移；
- **种子随 blob 走**：`option_sets` / `order_form_fields` 由 `app.field_definitions.catalog_seed`
  的内嵌 base64+zlib blob 提供，新增内置字段要更新 blob，而不是再加一条 seed 迁移；
- 新数据库直接 ``alembic upgrade head`` 初始化；已有数据库按版本迁移。

旧 SQLite 专用 DDL（如 DATETIME）不进基线，避免污染 PostgreSQL 初始化。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy.orm import Session

from app.domain.base import Base
from app.domain import attachments, foundation, imports, lists, notifications, options, parties, trade, users  # noqa: F401
from app.field_definitions.seeds import seed_foundation
from app.field_definitions.catalog_seed import seed_catalog

# 导入模块会向 Base.metadata 注册全部当前模型；元组同时让该副作用显式可见。
_DOMAIN_MODULES = (attachments, foundation, imports, lists, notifications, options, parties, trade, users)

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
