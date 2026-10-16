"""add account bound phone

Revision ID: 0017_account_bound_phone
Revises: 0016_account_business_classification
"""

from alembic import op
import sqlalchemy as sa


revision = "0017_account_bound_phone"
down_revision = "0016_account_business_classification"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("bound_phone", sa.String(length=64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("bound_phone")
