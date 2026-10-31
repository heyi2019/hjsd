"""0009 表改名：accounts → stocks（2026-10-28 用户裁决，全链路改名 A 案）。

口径：
- 库存账号台账表 accounts 更名为 stocks（表名与「库存」业务概念对齐）；
- SQLite ALTER TABLE RENAME 会自动更新其他表的外键引用与索引绑定；
- 命名索引 ix_accounts_* 同步重建为 ix_stocks_*；
- ORM/模块/API 路径/前端在同提交内全链路改名（app/accounts → app/stocks、
  Account → Stock、/accounts → /stocks）；
- 数据列名保持不变（account_id 外键、game_account、stock_no 等均不动），
  audit/attachment 的 entity_type="account" 字符串保持不变（历史数据兼容）。

downgrade 反向 RENAME。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def _index_names() -> list[str]:
    bind = op.get_bind()
    rows = bind.execute(
        text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stocks' "
             "AND name LIKE 'ix\\_accounts\\_%' ESCAPE '\\'")
    ).fetchall()
    return [r[0] for r in rows]


def upgrade() -> None:
    op.execute(text("ALTER TABLE accounts RENAME TO stocks"))
    for old_name in _index_names():
        suffix = old_name.removeprefix("ix_accounts_")
        op.execute(text(f"DROP INDEX {old_name}"))
        op.execute(text(f"CREATE INDEX ix_stocks_{suffix} ON stocks ({suffix})"))


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stocks' "
             "AND name LIKE 'ix\\_stocks\\_%' ESCAPE '\\'")
    ).fetchall()
    op.execute(text("ALTER TABLE stocks RENAME TO accounts"))
    for (old_name,) in rows:
        suffix = old_name.removeprefix("ix_stocks_")
        op.execute(text(f"DROP INDEX {old_name}"))
        op.execute(text(f"CREATE INDEX ix_accounts_{suffix} ON accounts ({suffix})"))

