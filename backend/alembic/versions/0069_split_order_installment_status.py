"""把分期阶段归入订单状态，并移除账号状态中的 INSTALLMENT。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql.naming import conv


revision = "0069_split_order_installment_status"
down_revision = "0068_add_independent_inventory_status"
branch_labels = None
depends_on = None


def _find_status_constraint(table_name: str) -> str:
    """Resolve the status CHECK by definition across accounts/stocks naming history."""
    inspector = sa.inspect(op.get_bind())
    for constraint in inspector.get_check_constraints(table_name):
        name = constraint.get("name")
        sqltext = (constraint.get("sqltext") or "").upper()
        # PostgreSQL renders ``status IN (...)`` as ``= ANY (ARRAY[...])``;
        # matching the stable enum members works across both dialects and old names.
        if table_name == "stocks":
            matches_status = "SOLD" in sqltext and "VOID" in sqltext
        else:
            matches_status = "COMPLETED" in sqltext and "CANCELLED" in sqltext
        if name and matches_status and "INVENTORY_STATUS" not in sqltext:
            return name
    raise RuntimeError(f"无法定位 {table_name} 的 status CHECK 约束")


def upgrade() -> None:
    # 历史账号的 INSTALLMENT 代表已签约出库，统一归入账号周期 SOLD；
    # 分期进度由 installments.status 记录，订单阶段由 orders.status 记录。
    op.execute(sa.text("UPDATE stocks SET status = 'SOLD' WHERE status = 'INSTALLMENT'"))

    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint("stocks")), type_="check")
        batch_op.create_check_constraint(
            conv("ck_stocks_account_status_valid"),
            "status IN ('IN_STOCK', 'SOLD', 'VOID')",
        )

    with op.batch_alter_table("orders", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint("orders")), type_="check")
        batch_op.create_check_constraint(
            conv("ck_orders_order_status_valid"),
            "status IN ('ACTIVE', 'INSTALLMENT', 'COMPLETED', 'CANCELLED')",
        )

    op.execute(
        sa.text(
            "UPDATE option_sets SET options = :options "
            "WHERE code = 'INVENTORY_STATUS'"
        ).bindparams(
            options='[{"value":"IN_STOCK","label":"在库"},{"value":"OUT_OF_STOCK","label":"出库"}]'
        )
    )
    op.execute(
        sa.text(
            "UPDATE option_sets SET options = :options "
            "WHERE code = 'ORDER_STATUS'"
        ).bindparams(
            options='[{"value":"ACTIVE","label":"进行中"},{"value":"INSTALLMENT","label":"分期中"},{"value":"COMPLETED","label":"已完成"},{"value":"CANCELLED","label":"已取消"}]'
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("orders", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint("orders")), type_="check")
        batch_op.create_check_constraint(
            conv("ck_orders_order_status_valid"),
            "status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')",
        )
    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint("stocks")), type_="check")
        batch_op.create_check_constraint(
            conv("ck_stocks_account_status_valid"),
            "status IN ('IN_STOCK', 'INSTALLMENT', 'SOLD', 'VOID')",
        )


