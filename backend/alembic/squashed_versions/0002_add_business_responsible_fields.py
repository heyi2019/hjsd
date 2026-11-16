"""Register required business responsible fields for account orders.

Revision ID: 0002
Revises: 0001
"""
from __future__ import annotations

from alembic import op
from sqlalchemy.orm import Session

from app.foundation.catalog_seed import seed_business_responsible_fields


revision: str = "0002"
down_revision: str | None = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        seed_business_responsible_fields(session, actor="system")
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    # 该字段是当前建单契约的一部分，不回滚删除，避免已配置数据失去字段定义。
    pass
