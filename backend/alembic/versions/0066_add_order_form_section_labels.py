"""新增表单板块标题配置表 order_form_section_labels。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0066_add_order_form_section_labels"
down_revision = "0065_allow_split_cashflow_per_event"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "order_form_section_labels",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("order_type_code", sa.String(length=16), nullable=False),
        sa.Column("section_key", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.Column("updated_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.UniqueConstraint(
            "order_type_code", "section_key", name="uq_order_form_section_labels_code_key"
        ),
    )


def downgrade() -> None:
    op.drop_table("order_form_section_labels")
