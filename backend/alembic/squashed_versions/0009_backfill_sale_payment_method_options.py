"""补齐回收/提号售出付款方式选项。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0009_backfill_sale_payment_method_options"
down_revision = "0008_align_existing_schema"
branch_labels = None
depends_on = None


PAYMENT_METHOD_OPTIONS = [
    {"value": "FULL", "label": "全款"},
    {"value": "INSTALLMENT", "label": "分期付款"},
]


def _payment_method_rows(bind: sa.Connection):
    table = sa.table(
        "order_form_fields",
        sa.column("id", sa.Integer),
        sa.column("order_type_code", sa.String),
        sa.column("field_key", sa.String),
        sa.column("options", sa.JSON),
    )
    return table, bind.execute(
        sa.select(table.c.id, table.c.options).where(
            table.c.order_type_code.in_(("SALEREC", "SALETH")),
            table.c.field_key == "payment_method",
        )
    ).all()


def upgrade() -> None:
    bind = op.get_bind()
    table, rows = _payment_method_rows(bind)
    for row in rows:
        if not row.options:
            bind.execute(
                sa.update(table)
                .where(table.c.id == row.id)
                .values(options=PAYMENT_METHOD_OPTIONS)
            )


def downgrade() -> None:
    # 只清理由本迁移补齐的选项；保留管理员后来修改过的配置。
    bind = op.get_bind()
    table, rows = _payment_method_rows(bind)
    for row in rows:
        if row.options == PAYMENT_METHOD_OPTIONS:
            bind.execute(
                sa.update(table)
                .where(table.c.id == row.id)
                .values(options=None)
            )
