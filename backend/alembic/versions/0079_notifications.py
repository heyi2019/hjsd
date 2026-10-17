"""新增系统通知中心（SYS-01-04）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0079_notifications"
down_revision = "0078_quality_issue_sequence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("notification_no", sa.String(length=32), nullable=False),
        sa.Column("recipient_user_id", sa.Integer(), nullable=False),
        sa.Column("notification_type", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=128), nullable=False),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(["recipient_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("notification_no"),
    )
    op.create_index(
        "ix_notifications_recipient_read",
        "notifications",
        ["recipient_user_id", "read_at"],
    )
    op.create_index(
        "ix_notifications_entity", "notifications", ["entity_type", "entity_id"]
    )
    bind = op.get_bind()
    exists = bind.execute(
        sa.text("SELECT 1 FROM document_sequences WHERE sequence_key = :key"),
        {"key": "NOTIFICATION"},
    ).first()
    if exists is None:
        bind.execute(
            sa.text(
                "INSERT INTO document_sequences "
                "(sequence_key, prefix, padding, current_value) "
                "VALUES (:key, :prefix, :padding, :current_value)"
            ),
            {"key": "NOTIFICATION", "prefix": "NTF", "padding": 4, "current_value": 0},
        )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM document_sequences WHERE sequence_key = 'NOTIFICATION'"))
    op.drop_index("ix_notifications_entity", table_name="notifications")
    op.drop_index("ix_notifications_recipient_read", table_name="notifications")
    op.drop_table("notifications")
