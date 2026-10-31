"""账号周期状态由 IN_STOCK 更名为 WAITING，库存状态保持独立。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql.naming import conv


revision = "0071_rename_account_waiting_status"
down_revision = "0070_hide_internal_installment_pending"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("UPDATE stocks SET status = 'WAITING' WHERE status = 'IN_STOCK'"))
    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv("ck_accounts_account_status_valid"), type_="check")
        batch_op.create_check_constraint(
            conv("ck_accounts_account_status_valid"),
            "status IN ('WAITING', 'SOLD', 'VOID')",
        )


def downgrade() -> None:
    op.execute(sa.text("UPDATE stocks SET status = 'IN_STOCK' WHERE status = 'WAITING'"))
    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv("ck_accounts_account_status_valid"), type_="check")
        batch_op.create_check_constraint(
            conv("ck_accounts_account_status_valid"),
            "status IN ('IN_STOCK', 'SOLD', 'VOID')",
        )
