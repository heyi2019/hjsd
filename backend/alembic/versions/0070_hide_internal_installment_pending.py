"""隐藏分期合约内部初始化状态 PENDING。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0070_hide_internal_installment_pending"
down_revision = "0069_split_order_installment_status"
branch_labels = None
depends_on = None


_PUBLIC_INSTALLMENT_STATUS_OPTIONS = (
    '[{"value":"ACTIVE","label":"还款中"},'
    '{"value":"OVERDUE","label":"逾期"},'
    '{"value":"SETTLED","label":"已结清"},'
    '{"value":"DELIVERED","label":"已交付"},'
    '{"value":"DEFAULTED","label":"违约"},'
    '{"value":"CLOSED","label":"已关闭"},'
    '{"value":"CANCELLED","label":"已取消"}]'
)


_LEGACY_INSTALLMENT_STATUS_OPTIONS = (
    '[{"value":"PENDING","label":"待首付"},'
    '{"value":"ACTIVE","label":"收款中"},'
    '{"value":"OVERDUE","label":"逾期"},'
    '{"value":"SETTLED","label":"已结清"},'
    '{"value":"DELIVERED","label":"已交付"},'
    '{"value":"DEFAULTED","label":"违约"},'
    '{"value":"CLOSED","label":"已关闭"},'
    '{"value":"CANCELLED","label":"已取消"}]'
)


def _set_options(options: str) -> None:
    op.execute(
        sa.text(
            "UPDATE option_sets SET options = :options "
            "WHERE code = 'INSTALLMENT_STATUS'"
        ).bindparams(options=options)
    )


def upgrade() -> None:
    _set_options(_PUBLIC_INSTALLMENT_STATUS_OPTIONS)


def downgrade() -> None:
    _set_options(_LEGACY_INSTALLMENT_STATUS_OPTIONS)

