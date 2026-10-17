"""Allow one person to participate in multiple allocation types."""
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("order_profit_allocations") as batch:
        batch.drop_constraint("uq_order_profit_alloc", type_="unique")
        batch.create_unique_constraint("uq_order_profit_alloc", ["order_id", "allocation_type", "user_id", "role"])


def downgrade() -> None:
    with op.batch_alter_table("order_profit_allocations") as batch:
        batch.drop_constraint("uq_order_profit_alloc", type_="unique")
        batch.create_unique_constraint("uq_order_profit_alloc", ["order_id", "user_id", "role"])
