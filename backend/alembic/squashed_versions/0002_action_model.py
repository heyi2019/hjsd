"""启用统一业务动作编码。"""
from __future__ import annotations

from alembic import op


revision = "0002_action_model"
down_revision = "0001"
branch_labels = None
depends_on = None

_EVENT_TYPES = (
    "BUY",
    "SELL",
    "DELIVER",
    "CANCEL",
    "OPERATE",
    "REBATE",
    "PROFIT_SHARE",
)


def _check(values: tuple[str, ...]) -> str:
    quoted = ", ".join(f"'{value}'" for value in values)
    return f"event_type IN ({quoted})"


def upgrade() -> None:
    op.drop_constraint(
        "event_type_valid",
        "order_events",
        type_="check",
    )
    op.create_check_constraint(
        "event_type_valid",
        "order_events",
        _check(_EVENT_TYPES),
    )


def downgrade() -> None:
    op.drop_constraint(
        "event_type_valid",
        "order_events",
        type_="check",
    )
    op.create_check_constraint(
        "event_type_valid",
        "order_events",
        _check(_EVENT_TYPES),
    )
