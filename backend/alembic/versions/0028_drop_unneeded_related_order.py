"""remove the unused standalone installment-order relation

Revision ID: 0028_drop_unneeded_related_order
Revises: 0027_add_self_installment_order
"""
from __future__ import annotations

from alembic import op


revision = "0028_drop_unneeded_related_order"
down_revision = "0027_add_self_installment_order"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint("fk_orders_related_order_id_orders", type_="foreignkey")
        batch.drop_column("related_order_id")


def downgrade() -> None:
    import sqlalchemy as sa

    with op.batch_alter_table("orders") as batch:
        batch.add_column(sa.Column("related_order_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_orders_related_order_id_orders", "orders", ["related_order_id"], ["id"], ondelete="RESTRICT"
        )
