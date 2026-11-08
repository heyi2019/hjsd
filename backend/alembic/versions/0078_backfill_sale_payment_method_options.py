"""补齐回收/提号售出付款方式选项。"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op


revision = "0078_backfill_sale_payment_method_options"
down_revision = "0077_remove_cashflow_nature"
branch_labels = None
depends_on = None


PAYMENT_METHOD_OPTIONS = json.dumps(
    [
        {"value": "FULL", "label": "全款"},
        {"value": "INSTALLMENT", "label": "分期付款"},
    ],
    ensure_ascii=False,
)


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE order_form_fields
            SET options = :options
            WHERE order_type_code IN ('SALEREC', 'SALETH')
              AND field_key = 'payment_method'
              AND (options IS NULL OR options = '[]')
            """
        ).bindparams(options=PAYMENT_METHOD_OPTIONS)
    )


def downgrade() -> None:
    # 只清理由本迁移补齐的选项；保留管理员后来修改过的配置。
    op.execute(
        sa.text(
            """
            UPDATE order_form_fields
            SET options = NULL
            WHERE order_type_code IN ('SALEREC', 'SALETH')
              AND field_key = 'payment_method'
              AND options = :options
            """
        ).bindparams(options=PAYMENT_METHOD_OPTIONS)
    )
