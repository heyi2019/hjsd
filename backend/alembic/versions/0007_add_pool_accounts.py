"""add pool account master data and cashflow account trace."""
from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "pool_accounts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("pool_id", sa.Integer(), nullable=False),
        sa.Column("account_no", sa.String(length=64), nullable=False),
        sa.Column("account_name", sa.String(length=128), nullable=False),
        sa.Column("account_type", sa.String(length=16), nullable=False),
        sa.Column("ownership", sa.String(length=16), nullable=False, server_default=sa.text("'OWNED'")),
        sa.Column("opening_balance", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'ACTIVE'")),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default=sa.text("'system'")),
        sa.Column("updated_by", sa.String(length=64), nullable=False, server_default=sa.text("'system'")),
        sa.CheckConstraint("account_type IN ('BANK', 'CASH', 'THIRD_PARTY')", name="pool_account_type_valid"),
        sa.CheckConstraint("ownership IN ('OWNED', 'CUSTODY', 'THIRD_PART')", name="pool_account_ownership_valid"),
        sa.CheckConstraint("status IN ('ACTIVE', 'DISABLED')", name="pool_account_status_valid"),
        sa.CheckConstraint("opening_balance >= 0", name="pool_account_opening_balance_nonnegative"),
        sa.ForeignKeyConstraint(["pool_id"], ["pools.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("account_no", name="uq_pool_accounts_account_no"),
    )
    op.create_index("ix_pool_accounts_pool_id", "pool_accounts", ["pool_id"])
    with op.batch_alter_table("cashflow") as batch:
        batch.add_column(sa.Column("pool_account_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_cashflow_pool_account_id", "pool_accounts", ["pool_account_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_cashflow_pool_account", ["pool_account_id", "occurred_on"])


def downgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_index("ix_cashflow_pool_account")
        batch.drop_constraint("fk_cashflow_pool_account_id", type_="foreignkey")
        batch.drop_column("pool_account_id")
    op.drop_index("ix_pool_accounts_pool_id", table_name="pool_accounts")
    op.drop_table("pool_accounts")
