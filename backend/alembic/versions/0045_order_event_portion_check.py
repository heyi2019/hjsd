"""constrain order event portions to the supported accounting dimensions"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text


revision = "0045_order_event_portion_check"
down_revision = "0044_remove_account_risk_level"
branch_labels = None
depends_on = None


_PORTION_CHECK = "portion IN ('PRINCIPAL', 'PROFIT', 'GROSS')"


def upgrade() -> None:
    # 旧实现曾把 COST 事件的类别误写入 portion；成本事件统一按本金维度归集。
    # 只修复这个已知、可确定的结构错误，其余非法值让 CHECK 明确阻断。
    op.get_bind().execute(
        text("UPDATE order_events SET portion = 'PRINCIPAL' WHERE portion = 'COST'")
    )
    with op.batch_alter_table("order_events", recreate="always") as batch:
        batch.create_check_constraint("portion_valid", _PORTION_CHECK)


def downgrade() -> None:
    with op.batch_alter_table("order_events", recreate="always") as batch:
        batch.drop_constraint("portion_valid", type_="check")
