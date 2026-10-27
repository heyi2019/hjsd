"""Allow extension fields to reference reusable option dictionaries.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-10-26 20:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("field_definitions")}
    if "option_set_code" not in columns:
        op.add_column("field_definitions", sa.Column("option_set_code", sa.String(length=64), nullable=True))


def downgrade() -> None:
    # 初始建表已包含该列，保留它以保证降级后 ORM 读取旧库时仍兼容。
    return None
