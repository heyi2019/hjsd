"""把分润支出加入开发环境的资金核算选项词典。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0005_enable_profit_share_option"
down_revision = "0004_profit_share_cashflow"
branch_labels = None
depends_on = None


_OPTION = {"value": "PROFIT_SHARE", "label": "分润支出"}


def _append_option(table_name: str, where: dict[str, str]) -> None:
    bind = op.get_bind()
    table = sa.table(
        table_name,
        sa.column("id", sa.Integer),
        sa.column("options", sa.JSON),
    )
    condition = sa.and_(*[sa.column(key) == value for key, value in where.items()])
    row = bind.execute(sa.select(table.c.id, table.c.options).where(condition)).first()
    if row is None:
        return
    options = list(row.options or [])
    if any(isinstance(item, dict) and item.get("value") == _OPTION["value"] for item in options):
        return
    bind.execute(
        sa.update(table).where(table.c.id == row.id).values(options=[*options, _OPTION])
    )


def _remove_option(table_name: str, where: dict[str, str]) -> None:
    bind = op.get_bind()
    table = sa.table(
        table_name,
        sa.column("id", sa.Integer),
        sa.column("options", sa.JSON),
    )
    condition = sa.and_(*[sa.column(key) == value for key, value in where.items()])
    row = bind.execute(sa.select(table.c.id, table.c.options).where(condition)).first()
    if row is None:
        return
    options = [
        item for item in (row.options or [])
        if not (isinstance(item, dict) and item.get("value") == _OPTION["value"])
    ]
    bind.execute(sa.update(table).where(table.c.id == row.id).values(options=options))


def upgrade() -> None:
    _append_option("option_sets", {"code": "FUND_FLOW_ACCOUNTING_ATTRIBUTE"})
    _append_option(
        "order_form_fields",
        {"order_type_code": "FUNDFLOW", "field_key": "accounting_attribute"},
    )


def downgrade() -> None:
    _remove_option("option_sets", {"code": "FUND_FLOW_ACCOUNTING_ATTRIBUTE"})
    _remove_option(
        "order_form_fields",
        {"order_type_code": "FUNDFLOW", "field_key": "accounting_attribute"},
    )
