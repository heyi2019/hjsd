"""add_allocation_amount_to_order_profit_allocations：分润支持按金额分。

背景：分润原来只能填比例（allocation_rate），实际业务里经常直接谈「这单给他
500」。新增 allocation_amount，与 allocation_rate 互斥、二者都选填：

- 只填比例 → 报表按 利润 × 比例 / 100 计算应付基数（原口径不变）；
- 填金额 → 报表直接取该金额作为应付基数。

存量行全部落 0，行为与升级前一致。

Revision ID: 16c8d9e0f1a2
Revises: 15b7c8d9e0f1
Create Date: 2026-10-26 23:10:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.core.money import Amount

revision: str = "16c8d9e0f1a2"
down_revision: str | None = "15b7c8d9e0f1"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "order_profit_allocations"


def upgrade() -> None:
    columns = {col["name"] for col in sa.inspect(op.get_bind()).get_columns(TABLE)}
    if "allocation_amount" in columns:
        return
    op.add_column(
        TABLE,
        sa.Column("allocation_amount", Amount, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    columns = {col["name"] for col in sa.inspect(op.get_bind()).get_columns(TABLE)}
    if "allocation_amount" not in columns:
        return
    with op.batch_alter_table(TABLE) as batch:
        batch.drop_column("allocation_amount")
