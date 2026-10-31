"""清理没有返点明细关联的旧返点资金流水。"""
from __future__ import annotations

from alembic import op


revision = "0061_remove_orphan_rebate_cashflows"
down_revision = "0060_remove_rebate_settlement_history"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 返点新流程不再单独产生结算/冲销流水；旧实现残留流水不再进入资金中心。
    op.execute(
        """
        DELETE FROM cashflow
        WHERE category IN ('REBATE', 'REBATE_FEE', 'REBATE_REVERSAL', 'REBATE_FEE_REVERSAL')
        """
    )


def downgrade() -> None:
    # 历史流水按业务要求删除，不可恢复。
    pass

