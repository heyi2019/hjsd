"""add structured source to counterparties"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0018_counterparty_source"
down_revision = "0017_account_bound_phone"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("counterparties") as batch:
        batch.add_column(sa.Column("source", sa.String(length=64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("counterparties") as batch:
        batch.drop_column("source")
