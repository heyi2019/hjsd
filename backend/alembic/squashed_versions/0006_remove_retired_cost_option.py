"""固定运行时业务动作词典。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0006_remove_retired_cost_option"
down_revision = "0005_enable_profit_share_option"
branch_labels = None
depends_on = None


_CURRENT_OPTIONS = [
    {"value": "BUY", "label": "买号"},
    {"value": "SELL", "label": "售出"},
    {"value": "DELIVER", "label": "交付"},
    {"value": "CANCEL", "label": "取消"},
    {"value": "OPERATE", "label": "运营"},
    {"value": "REBATE", "label": "返点"},
    {"value": "PROFIT_SHARE", "label": "分润"},
]


def _update_order_event_options() -> None:
    bind = op.get_bind()
    table = sa.table(
        "option_sets",
        sa.column("code", sa.String),
        sa.column("options", sa.JSON),
    )
    row = bind.execute(
        sa.select(table.c.options).where(table.c.code == "ORDER_EVENT_TYPE")
    ).first()
    if row is None:
        return
    options = _CURRENT_OPTIONS
    bind.execute(
        sa.update(table)
        .where(table.c.code == "ORDER_EVENT_TYPE")
        .values(options=options)
    )


def upgrade() -> None:
    _update_order_event_options()


def downgrade() -> None:
    _update_order_event_options()
