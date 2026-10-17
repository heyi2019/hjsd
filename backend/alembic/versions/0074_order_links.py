"""新增订单上下游关联与拆分份额表。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0074_order_links"
down_revision = "0073_user_phone_hire_date"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "order_links",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("source_order_id", sa.Integer(), nullable=False),
        sa.Column("target_order_id", sa.Integer(), nullable=False),
        sa.Column("relation_type", sa.String(length=16), nullable=False),
        sa.Column("split_ratio", sa.Numeric(18, 2), nullable=True),
        sa.Column("split_amount", sa.Numeric(18, 2), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "source_order_id <> target_order_id", name="order_link_not_self"
        ),
        sa.CheckConstraint(
            "relation_type IN ('SOURCE', 'FOLLOW_UP')", name="order_link_type_valid"
        ),
        sa.CheckConstraint(
            "split_ratio IS NULL OR (split_ratio > 0 AND split_ratio <= 100)",
            name="order_link_ratio_valid",
        ),
        sa.CheckConstraint(
            "split_amount IS NULL OR split_amount > 0", name="order_link_amount_valid"
        ),
        sa.ForeignKeyConstraint(
            ["source_order_id"], ["orders.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["target_order_id"], ["orders.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_order_id", "target_order_id", name="uq_order_links_pair"),
    )
    op.create_index("ix_order_links_source", "order_links", ["source_order_id"])
    op.create_index("ix_order_links_target", "order_links", ["target_order_id"])


def downgrade() -> None:
    op.drop_index("ix_order_links_target", table_name="order_links")
    op.drop_index("ix_order_links_source", table_name="order_links")
    op.drop_table("order_links")
