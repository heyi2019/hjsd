"""allow TH orders to reference pickup inventory and reserve snapshots for DFQ"""
from __future__ import annotations

from typing import Sequence

from alembic import op


revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("orders", schema=None) as batch_op:
        batch_op.drop_constraint("order_account_link_type_valid", type_="check")
        batch_op.drop_constraint("order_account_snapshot_type_valid", type_="check")
        batch_op.create_check_constraint(
            "order_account_link_type_valid",
            "order_type != 'DFQ' OR account_id IS NULL",
        )
        batch_op.create_check_constraint(
            "order_account_snapshot_type_valid",
            "order_type = 'DFQ' OR account_snapshot IS NULL OR account_snapshot = 'null'",
        )


def downgrade() -> None:
    with op.batch_alter_table("orders", schema=None) as batch_op:
        batch_op.drop_constraint("order_account_link_type_valid", type_="check")
        batch_op.drop_constraint("order_account_snapshot_type_valid", type_="check")
        batch_op.create_check_constraint(
            "order_account_link_type_valid",
            "order_type NOT IN ('TH', 'DFQ') OR account_id IS NULL",
        )
        batch_op.create_check_constraint(
            "order_account_snapshot_type_valid",
            "order_type IN ('TH', 'DFQ') OR account_snapshot IS NULL OR account_snapshot = 'null'",
        )
