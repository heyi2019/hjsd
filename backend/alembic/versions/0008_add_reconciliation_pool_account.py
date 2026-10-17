"""add account scope to reconciliations

Revision ID: 0008
Revises: 0007
"""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("reconciliations", recreate="always") as batch_op:
        batch_op.add_column(sa.Column("pool_account_id", sa.Integer(), nullable=True))
        batch_op.drop_constraint("uq_reconciliations_scope", type_="unique")
        batch_op.create_unique_constraint("uq_reconciliations_scope", ["pool_id", "pool_account_id", "reconciled_on", "account_label"])
        batch_op.create_foreign_key("fk_reconciliations_pool_account_id", "pool_accounts", ["pool_account_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    with op.batch_alter_table("reconciliations", recreate="always") as batch_op:
        batch_op.drop_constraint("fk_reconciliations_pool_account_id", type_="foreignkey")
        batch_op.drop_constraint("uq_reconciliations_scope", type_="unique")
        batch_op.create_unique_constraint("uq_reconciliations_scope", ["pool_id", "reconciled_on", "account_label"])
        batch_op.drop_column("pool_account_id")
