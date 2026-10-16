"""add daily reconciliation snapshots

Revision ID: 0041_daily_reconciliation
Revises: 0040_rebate_settlement_reversal
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0041_daily_reconciliation"
down_revision = "0040_rebate_settlement_reversal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reconciliations",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("pool_id", sa.Integer(), nullable=False),
        sa.Column("reconciled_on", sa.Date(), nullable=False),
        sa.Column("account_label", sa.String(length=128), nullable=False),
        sa.Column("system_balance", sa.Numeric(18, 2), nullable=False),
        sa.Column("statement_balance", sa.Numeric(18, 2), nullable=False),
        sa.Column("difference", sa.Numeric(18, 2), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("unmatched_flow_ids", sa.JSON(), nullable=False),
        sa.Column("resolved_by", sa.String(length=64), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "status IN ('OPEN', 'RESOLVED')",
            name="reconciliation_status_valid",
        ),
        sa.CheckConstraint(
            "statement_balance >= 0",
            name="reconciliation_statement_nonneg",
        ),
        sa.ForeignKeyConstraint(["pool_id"], ["pools.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "pool_id",
            "reconciled_on",
            "account_label",
            name="uq_reconciliations_scope",
        ),
    )
    op.create_index(
        "ix_reconciliations_pool_date",
        "reconciliations",
        ["pool_id", "reconciled_on"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_reconciliations_pool_date", table_name="reconciliations")
    op.drop_table("reconciliations")
