"""add profit allocation type"""

from alembic import op
import sqlalchemy as sa


revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("order_profit_allocations", sa.Column("allocation_type", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("order_profit_allocations", "allocation_type")
