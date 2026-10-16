"""为每笔资金流水补充直接订单关联，统一资金明细追溯入口。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0033_link_cashflows_to_orders"
down_revision = "0032_drop_installment_account_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("cashflow")}
    if "order_id" not in columns:
        with op.batch_alter_table("cashflow") as batch:
            batch.add_column(sa.Column("order_id", sa.Integer(), nullable=True))
            batch.create_foreign_key(
                "fk_cashflow_order_id_orders",
                "orders",
                ["order_id"],
                ["id"],
                ondelete="SET NULL",
            )
            batch.create_index("ix_cashflow_order", ["order_id"], unique=False)

    connection.execute(
        sa.text(
            "UPDATE cashflow SET order_id = "
            "(SELECT order_id FROM order_events WHERE order_events.id = cashflow.order_event_id) "
            "WHERE order_id IS NULL AND order_event_id IS NOT NULL"
        )
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    foreign_key_name = next(
        (
            foreign_key.get("name")
            for foreign_key in inspector.get_foreign_keys("cashflow")
            if foreign_key.get("constrained_columns") == ["order_id"]
        ),
        None,
    )
    with op.batch_alter_table("cashflow") as batch:
        if "ix_cashflow_order" in {index["name"] for index in inspector.get_indexes("cashflow")}:
            batch.drop_index("ix_cashflow_order")
        if foreign_key_name:
            batch.drop_constraint(foreign_key_name, type_="foreignkey")
        batch.drop_column("order_id")
