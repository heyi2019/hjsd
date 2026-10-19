"""Store the final installment adjustment while preserving existing contracts."""
from alembic import op
import sqlalchemy as sa

revision = "0003_installment_adjustment"
down_revision = "0002_event_operators"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("installments", sa.Column("final_period_adjustment", sa.Numeric(18, 2), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("installments", "final_period_adjustment")
