"""Add action-level multi-operator snapshots for non-order forms.

Revision ID: 0005
Revises: 0004
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0005"
down_revision: str | None = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "business_operation_operators",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=128), nullable=False),
        sa.Column("operation_key", sa.String(length=64), nullable=False),
        sa.Column("operator_user_ids", sa.JSON(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "entity_type", "entity_id", "operation_key",
            name="uq_business_operation_operators_key",
        ),
    )
    op.create_index(
        "ix_business_operation_operators_entity",
        "business_operation_operators",
        ["entity_type", "entity_id", "id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_business_operation_operators_entity",
        table_name="business_operation_operators",
    )
    op.drop_table("business_operation_operators")
