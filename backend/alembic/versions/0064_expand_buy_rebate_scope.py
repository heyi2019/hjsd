"""修正买号返点类型说明，覆盖回收、提号和代分期。"""
from __future__ import annotations

from alembic import op


revision = "0064_expand_buy_rebate_scope"
down_revision = "0063_remove_legacy_rebate_configs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE option_sets
        SET options = '[{"value":"BUY","label":"买号返点（对应回收/提号/代分期）"},{"value":"SELL","label":"卖号返点（对应售出）"}]',
            description = '返点类型：买号返点可关联回收、提号或代分期；卖号返点关联售出。'
        WHERE code = 'REBATE_TYPE'
        """
    )


def downgrade() -> None:
    # 新口径说明不回退到仅支持回收的旧文案。
    pass

