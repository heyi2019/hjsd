"""将现有返点记录统一为已登记口径。"""
from __future__ import annotations

from alembic import op


revision = "0062_normalize_rebate_status"
down_revision = "0061_remove_orphan_rebate_cashflows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 返点登记本身就是完成记录，不再保留 OPEN/部分结算/作废状态。
    op.execute("UPDATE rebate_records SET status = 'SETTLED'")


def downgrade() -> None:
    # 状态归一化不可逆，回退不恢复旧状态。
    pass
