"""add per-period installment service fee rate"""

from alembic import op
import sqlalchemy as sa


revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installment_schedules", recreate="always") as batch_op:
        batch_op.add_column(
            sa.Column("service_fee_rate", sa.Numeric(18, 2), nullable=False, server_default="0")
        )


def downgrade() -> None:
    with op.batch_alter_table("installment_schedules", recreate="always") as batch_op:
        batch_op.drop_column("service_fee_rate")
