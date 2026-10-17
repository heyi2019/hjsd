"""add refund responsibility to order events"""

from alembic import op
import sqlalchemy as sa


revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("order_events", sa.Column("refund_responsibility", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("order_events", "refund_responsibility")
