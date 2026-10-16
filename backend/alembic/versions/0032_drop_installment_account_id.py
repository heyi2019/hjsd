"""删除分期合约重复的账号关联，统一从所属订单取得库存账号。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0032_drop_installment_account_id"
down_revision = "0031_standardize_import_source_kinds"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("installments")}
    if "account_id" in columns:
        with op.batch_alter_table("installments") as batch:
            batch.drop_column("account_id")


def downgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.add_column(sa.Column("account_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_installments_account_id_accounts",
            "accounts",
            ["account_id"],
            ["id"],
            ondelete="SET NULL",
        )
