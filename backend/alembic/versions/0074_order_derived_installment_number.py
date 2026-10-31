"""分期合约号改为业务订单号派生，不再维护独立 FQ 序列。"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "0074_order_derived_installment_number"
down_revision = "0073_remove_retired_product_checks"
branch_labels = None
depends_on = None


def _rename_sequence_option() -> None:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT options FROM option_sets WHERE code = 'SEQUENCE_KEY'")
    ).scalar_one_or_none()
    if row is None:
        return
    options = row if isinstance(row, list) else json.loads(row)
    changed = False
    for option in options:
        if option.get("value") == "INSTALLMENT" and option.get("label") != "分期合约号":
            option["label"] = "分期合约号"
            changed = True
    if changed:
        option_sets = sa.table(
            "option_sets",
            sa.column("code", sa.String),
            sa.column("options", sa.JSON),
        )
        bind.execute(
            sa.update(option_sets)
            .where(option_sets.c.code == "SEQUENCE_KEY")
            .values(options=options)
        )


def upgrade() -> None:
    op.execute(
        sa.text("DELETE FROM document_sequences WHERE sequence_key = 'INSTALLMENT'")
    )
    _rename_sequence_option()


def downgrade() -> None:
    op.execute(
        sa.text(
            "INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) "
            "SELECT 'INSTALLMENT', 'FQ', 4, 0 "
            "WHERE NOT EXISTS ("
            "SELECT 1 FROM document_sequences WHERE sequence_key = 'INSTALLMENT'"
            ")"
        )
    )
