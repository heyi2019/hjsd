"""删除返点旧结算/冲销/作废表单配置和状态字典。"""
from __future__ import annotations

from alembic import op


revision = "0063_remove_legacy_rebate_configs"
down_revision = "0062_normalize_rebate_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM order_form_fields
        WHERE order_type_code IN ('REBSETTLE', 'REBREVERSE', 'REBATEVOID')
        """
    )
    op.execute("DELETE FROM option_sets WHERE code = 'REBATE_STATUS'")


def downgrade() -> None:
    # 旧配置按新业务口径删除，不恢复。
    pass
