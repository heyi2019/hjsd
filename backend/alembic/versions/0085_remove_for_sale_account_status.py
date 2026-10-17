"""移除无业务意义的待售账号状态，统一按在库处理。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text


revision = "0085_remove_for_sale_account_status"
down_revision = "0084_field_definition_rules"
branch_labels = None
depends_on = None


_ACCOUNT_STATUS_CHECK = "status IN ('IN_STOCK', 'INSTALLMENT', 'SOLD', 'VOID')"
_ACCOUNT_STATUS_CHECK_WITH_FOR_SALE = "status IN ('IN_STOCK', 'INSTALLMENT', 'FOR_SALE', 'SOLD', 'VOID')"


def upgrade() -> None:
    bind = op.get_bind()
    # 旧数据中的待售仅表示尚未售出，按当前口径归并为在库，再收紧约束。
    bind.execute(text("UPDATE accounts SET status = 'IN_STOCK' WHERE status = 'FOR_SALE'"))
    with op.batch_alter_table("accounts") as batch:
        batch.drop_constraint("account_status_valid", type_="check")
        batch.create_check_constraint("account_status_valid", _ACCOUNT_STATUS_CHECK)


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_constraint("account_status_valid", type_="check")
        batch.create_check_constraint(
            "account_status_valid", _ACCOUNT_STATUS_CHECK_WITH_FOR_SALE
        )
