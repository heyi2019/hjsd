"""允许一笔订单事件对应多笔资金流水（售出分笔进不同资金池）。

原 uq_cashflow_event 限制 cashflow.order_event_id 唯一，导致一笔 SELL 只能派生一笔流水。
售出拆分场景下一笔 SELL 需要同时进两个资金池，故改为允许同一事件对应多笔流水。
"""
from __future__ import annotations

from alembic import op


revision = "0065_allow_split_cashflow_per_event"
down_revision = "0064_expand_buy_rebate_scope"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("uq_cashflow_event", "cashflow", type_="unique")


def downgrade() -> None:
    op.create_unique_constraint("uq_cashflow_event", "cashflow", ["order_event_id"])
