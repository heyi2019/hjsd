"""rename the inventory identifier field

Revision ID: 0029_rename_account_no_to_inventory_no
Revises: 0028_drop_unneeded_related_order
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0029_rename_account_no_to_inventory_no"
down_revision = "0028_drop_unneeded_related_order"
branch_labels = None
depends_on = None


def _drop_inventory_key(name: str) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if any(item.get("name") == name for item in inspector.get_unique_constraints("accounts")):
        with op.batch_alter_table("accounts") as batch:
            batch.drop_constraint(name, type_="unique")
    if any(item.get("name") == name for item in inspector.get_indexes("accounts")):
        op.drop_index(name, table_name="accounts")


def upgrade() -> None:
    _drop_inventory_key("uq_accounts_no")
    with op.batch_alter_table("accounts") as batch:
        batch.alter_column("account_no", new_column_name="inventory_no")
    op.create_index("uq_accounts_inventory_no", "accounts", ["inventory_no"], unique=True)


def downgrade() -> None:
    _drop_inventory_key("uq_accounts_inventory_no")
    with op.batch_alter_table("accounts") as batch:
        batch.alter_column("inventory_no", new_column_name="account_no")
    op.create_index("uq_accounts_no", "accounts", ["account_no"], unique=True)
