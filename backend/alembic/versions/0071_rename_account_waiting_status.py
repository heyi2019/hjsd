"""账号周期状态由 IN_STOCK 更名为 WAITING，库存状态保持独立。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql.naming import conv


revision = "0071_rename_account_waiting_status"
down_revision = "0070_hide_internal_installment_pending"
branch_labels = None
depends_on = None


def _find_status_constraint() -> str:
    """Resolve the status CHECK by definition across accounts/stocks naming history."""
    inspector = sa.inspect(op.get_bind())
    for constraint in inspector.get_check_constraints("stocks"):
        name = constraint.get("name")
        sqltext = (constraint.get("sqltext") or "").upper()
        # PostgreSQL renders ``status IN (...)`` as ``= ANY (ARRAY[...])``;
        # SOLD + VOID identifies the account-cycle status in both dialects.
        if name and "SOLD" in sqltext and "VOID" in sqltext and "INVENTORY_STATUS" not in sqltext:
            return name
    raise RuntimeError("无法定位 stocks 的 status CHECK 约束")


def upgrade() -> None:
    # SQLite 的 CHECK 约束会在 UPDATE 时立即校验，先放宽约束才能迁移旧值。
    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint()), type_="check")
        batch_op.create_check_constraint(
            conv("ck_stocks_account_status_valid"),
            "status IN ('IN_STOCK', 'WAITING', 'SOLD', 'VOID')",
        )
    op.execute(sa.text("UPDATE stocks SET status = 'WAITING' WHERE status = 'IN_STOCK'"))
    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint()), type_="check")
        batch_op.create_check_constraint(
            conv("ck_stocks_account_status_valid"),
            "status IN ('WAITING', 'SOLD', 'VOID')",
        )


def downgrade() -> None:
    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint()), type_="check")
        batch_op.create_check_constraint(
            conv("ck_stocks_account_status_valid"),
            "status IN ('IN_STOCK', 'WAITING', 'SOLD', 'VOID')",
        )
    op.execute(sa.text("UPDATE stocks SET status = 'IN_STOCK' WHERE status = 'WAITING'"))
    with op.batch_alter_table("stocks", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(_find_status_constraint()), type_="check")
        batch_op.create_check_constraint(
            conv("ck_stocks_account_status_valid"),
            "status IN ('IN_STOCK', 'SOLD', 'VOID')",
        )

