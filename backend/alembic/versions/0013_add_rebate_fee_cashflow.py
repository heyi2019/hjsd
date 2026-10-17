"""Link rebate settlement to its separate fee cashflow."""
from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rebate_settlements") as batch:
        batch.add_column(sa.Column("fee_cashflow_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_rebate_settlements_fee_cashflow_id_cashflow", "cashflow", ["fee_cashflow_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    with op.batch_alter_table("rebate_settlements") as batch:
        batch.drop_constraint("fk_rebate_settlements_fee_cashflow_id_cashflow", type_="foreignkey")
        batch.drop_column("fee_cashflow_id")
