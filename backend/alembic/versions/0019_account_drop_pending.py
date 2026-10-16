"""移除账号旧 PENDING/待收状态（账号创建即进入在库）。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import MetaData, Table, text

revision = "0019_account_drop_pending"
down_revision = "0018_counterparty_source"
branch_labels = None
depends_on = None

_ACCOUNT_STATUS_CHECK_NOW = "('IN_STOCK', 'INSTALLMENT', 'FOR_SALE', 'SOLD', 'VOID')"
_ACCOUNT_STATUS_CHECK_WITH_PENDING = "('PENDING', 'IN_STOCK', 'INSTALLMENT', 'FOR_SALE', 'SOLD', 'VOID')"


def _rebuild_accounts(bind, status_check: str) -> None:
    """按迁移当时的真实表结构重建 accounts，只替换状态 CHECK。

    不能使用当前 ORM 作为建表来源：后续迁移（如 0020 的描述/图片字段）
    可能已经进入 ORM，但在 0019 执行时数据库中还不存在。
    """
    metadata = MetaData()
    accounts = Table("accounts", metadata, autoload_with=bind)
    with op.batch_alter_table(
        "accounts", recreate="always", copy_from=accounts
    ) as batch:
        batch.drop_constraint("account_status_valid", type_="check")
        batch.create_check_constraint(
            "account_status_valid", f"status IN {status_check}"
        )


def upgrade() -> None:
    bind = op.get_bind()
    # 旧库若残留 PENDING，按当前产品口径统一视为在库后再收紧 CHECK。
    bind.execute(text("UPDATE accounts SET status = 'IN_STOCK' WHERE status = 'PENDING'"))
    _rebuild_accounts(bind, _ACCOUNT_STATUS_CHECK_NOW)


def downgrade() -> None:
    _rebuild_accounts(op.get_bind(), _ACCOUNT_STATUS_CHECK_WITH_PENDING)
