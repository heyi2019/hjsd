"""Use 操作人 terminology for business employee selectors.

Revision ID: 0004
Revises: 0003
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0004"
down_revision: str | None = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    table = sa.table(
        "order_form_fields",
        sa.column("order_type_code", sa.String()),
        sa.column("field_key", sa.String()),
        sa.column("label", sa.String()),
    )
    op.execute(
        table.update()
        .where(table.c.field_key == "business_responsible_ids")
        .values(
            label=sa.case(
                (table.c.order_type_code == "HS", "回收操作人"),
                (table.c.order_type_code == "TH", "提号操作人"),
                (table.c.order_type_code == "DG", "代挂操作人"),
                else_=table.c.label,
            )
        )
    )


def downgrade() -> None:
    table = sa.table(
        "order_form_fields",
        sa.column("order_type_code", sa.String()),
        sa.column("field_key", sa.String()),
        sa.column("label", sa.String()),
    )
    op.execute(
        table.update()
        .where(table.c.field_key == "business_responsible_ids")
        .values(
            label=sa.case(
                (table.c.order_type_code == "HS", "回收负责人"),
                (table.c.order_type_code == "TH", "提号负责人"),
                (table.c.order_type_code == "DG", "代挂负责人"),
                else_=table.c.label,
            )
        )
    )
