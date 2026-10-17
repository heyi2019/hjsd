"""新增会计期间锁定表（FIN-05-02）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0076_period_locks"
down_revision = "0075_customer_leads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "period_locks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("period", sa.String(length=7), nullable=False),
        sa.Column("locked_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("locked_by", sa.String(length=64), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "length(period) = 7 AND substr(period, 5, 1) = '-'",
            name="period_lock_format_valid",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("period", name="uq_period_locks_period"),
    )


def downgrade() -> None:
    op.drop_table("period_locks")
