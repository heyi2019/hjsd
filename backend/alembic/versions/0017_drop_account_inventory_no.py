"""Remove inventory_no from accounts.

库存中心建档入口已移除，库存编号不再产生，故从 accounts 表删除该字段及其唯一索引。
"""
from alembic import op
import sqlalchemy as sa

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        # SQLite batch rebuild reflects uq_accounts_inventory_no and would
        # recreate it on the temp table without inventory_no -> drop it first.
        batch.drop_index("uq_accounts_inventory_no")
        batch.drop_column("inventory_no")


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(
            sa.Column("inventory_no", sa.String(32), nullable=True)
        )
        batch.create_index("uq_accounts_inventory_no", ["inventory_no"], unique=True)
