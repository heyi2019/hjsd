"""彻底移除会计账期锁定（period_locks）相关逻辑。

账期（会计期间锁定）功能已整体下线：写入守卫、管理接口、前端面板、
权限、错误码、审计动作与 PeriodLock 模型均已删除。本迁移删除 period_locks
物理表。down_reverse 重建该表以便回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0067_drop_period_locks"
down_revision = "0066_add_order_form_section_labels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("period_locks")


def downgrade() -> None:
    op.create_table(
        "period_locks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("period", sa.String(length=7), nullable=False),
        sa.Column("locked_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("locked_by", sa.String(length=64), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("form_extra", sa.JSON(), nullable=True),
        sa.CheckConstraint(
            "length(period) = 7 AND substr(period, 5, 1) = '-'",
            name="period_lock_format_valid",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_period_locks")),
        sa.UniqueConstraint("period", name="uq_period_locks_period"),
    )
