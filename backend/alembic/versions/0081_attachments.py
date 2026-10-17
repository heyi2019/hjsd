"""新增统一业务附件中心（SYS-01-03 / FIN-02-06）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0081_attachments"
down_revision = "0080_rebate_expected_on"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "attachments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("attachment_no", sa.String(length=32), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=128), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("storage_key", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("attachment_no"),
        sa.UniqueConstraint("storage_key"),
    )
    op.create_index(
        "ix_attachments_entity", "attachments", ["entity_type", "entity_id"]
    )
    op.create_index("ix_attachments_active", "attachments", ["deleted_at"])
    bind = op.get_bind()
    exists = bind.execute(
        sa.text("SELECT 1 FROM document_sequences WHERE sequence_key = :key"),
        {"key": "ATTACHMENT"},
    ).first()
    if exists is None:
        bind.execute(
            sa.text(
                "INSERT INTO document_sequences "
                "(sequence_key, prefix, padding, current_value) "
                "VALUES (:key, :prefix, :padding, :current_value)"
            ),
            {"key": "ATTACHMENT", "prefix": "ATT", "padding": 4, "current_value": 0},
        )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM document_sequences WHERE sequence_key = 'ATTACHMENT'"))
    op.drop_index("ix_attachments_active", table_name="attachments")
    op.drop_index("ix_attachments_entity", table_name="attachments")
    op.drop_table("attachments")
