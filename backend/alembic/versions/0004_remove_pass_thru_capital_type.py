"""remove the obsolete pass-through capital classification"""
from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # PASS_THRU was only a classification for the old TH offset flow.  TH is
    # now an ordinary STOCK order and any custom definitions using the removed
    # value are normalized to the same explicit capital type.
    op.execute(
        sa.text("UPDATE orders SET capital_type = 'STOCK' WHERE capital_type = 'PASS_THRU'")
    )
    op.execute(
        sa.text(
            "UPDATE order_type_defs SET capital_type = 'STOCK' "
            "WHERE capital_type = 'PASS_THRU'"
        )
    )
    op.execute(
        sa.text(
            "UPDATE order_type_defs SET description = '买家找我买号，我去同行那里提号卖给他（库存型）' "
            "WHERE code = 'TH'"
        )
    )

    with op.batch_alter_table("orders", schema=None) as batch_op:
        batch_op.drop_constraint("order_capital_type_valid", type_="check")
        batch_op.create_check_constraint(
            "order_capital_type_valid",
            "capital_type IN ('STOCK', 'ZERO', 'CREDIT')",
        )

    with op.batch_alter_table("order_type_defs", schema=None) as batch_op:
        batch_op.drop_constraint("capital_type_valid", type_="check")
        batch_op.create_check_constraint(
            "capital_type_valid",
            "capital_type IN ('STOCK', 'ZERO', 'CREDIT')",
        )


def downgrade() -> None:
    # Downgrade restores the schema allowance for old databases, but does not
    # recreate the removed business classification on rows already normalized.
    with op.batch_alter_table("order_type_defs", schema=None) as batch_op:
        batch_op.drop_constraint("capital_type_valid", type_="check")
        batch_op.create_check_constraint(
            "capital_type_valid",
            "capital_type IN ('STOCK', 'PASS_THRU', 'ZERO', 'CREDIT')",
        )

    with op.batch_alter_table("orders", schema=None) as batch_op:
        batch_op.drop_constraint("order_capital_type_valid", type_="check")
        batch_op.create_check_constraint(
            "order_capital_type_valid",
            "capital_type IN ('STOCK', 'PASS_THRU', 'ZERO', 'CREDIT')",
        )
