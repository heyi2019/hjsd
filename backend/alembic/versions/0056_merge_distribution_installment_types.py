"""把历史提号/代挂分期统一迁移为库存分期出售。

提号、代挂账号进入库存后，售出分期与回收库存采用同一套 STOCK_SALE
合约口径；旧类型仅作为历史数据兼容值保留在枚举约束中，不再创建或展示。
"""

from alembic import op
import sqlalchemy as sa


revision = "0056_merge_distribution_installment_types"
down_revision = "0055_move_consignment_to_operation_section"
branch_labels = None
depends_on = None


LEGACY_CONTRACT_TYPES = ("PICKUP_SALE", "CONSIGNMENT_SALE")


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE installments "
            "SET contract_type = 'STOCK_SALE' "
            "WHERE contract_type IN ('PICKUP_SALE', 'CONSIGNMENT_SALE')"
        )
    )


def downgrade() -> None:
    # 两种旧类型已合并为同一业务口径，迁移后无法可靠区分原始类型，故不回写。
    pass

