"""清理返点旧结算/冲销历史数据。

返点登记即完成记录，新的业务流程不再产生结算、冲销或作废数据。
旧结算流水属于已废弃的历史实现，连同其手续费和反向流水一并清理，
避免资金中心继续展示已经取消的业务动作。
"""
from __future__ import annotations

from alembic import op


revision = "0060_remove_rebate_settlement_history"
down_revision = "0059_remove_rebate_expected_on"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 先删除反向流水，再删除原流水：cashflow.reversal_of_id 是 RESTRICT 外键。
    op.execute(
        """
        DELETE FROM cashflow
        WHERE reversal_of_id IN (
          SELECT cashflow_id FROM rebate_settlements WHERE cashflow_id IS NOT NULL
          UNION
          SELECT fee_cashflow_id FROM rebate_settlements WHERE fee_cashflow_id IS NOT NULL
        )
        """
    )
    op.execute(
        """
        DELETE FROM cashflow
        WHERE id IN (
          SELECT cashflow_id FROM rebate_settlements WHERE cashflow_id IS NOT NULL
          UNION
          SELECT fee_cashflow_id FROM rebate_settlements WHERE fee_cashflow_id IS NOT NULL
        )
        """
    )
    # settlement.cashflow_id / fee_cashflow_id 均为 SET NULL，流水清理后再删记录。
    op.execute("DELETE FROM rebate_settlements")


def downgrade() -> None:
    # 历史数据按业务要求删除，不可恢复；保留空回滚以支持迁移链回退。
    pass

