"""0004 账号台账库存编号（KU 编码）。

口径（2026-10-28 用户裁决）：
- accounts 新增 stock_no（VARCHAR(32)，唯一），系统生成 KU + 四位流水（KU0001…），不可手改。
- document_sequences 新增 STOCK_NO 域（prefix=KU, padding=4）；allocate_number 复用现有序列机制。
- 存量账号按 id 升序回填 KU0001…KU0NNN，序列 current_value 置为 NNN（新账号从 KU0(NNN+1) 起）。
- 编号位数 padding=4 落在 0003 已放宽的 padding<=6 约束内，无需改动共享序列表约束。
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # 1) 加列：可空，不内联唯一约束（SQLite 不支持 ADD COLUMN 同时建唯一约束）。
    op.add_column("accounts", sa.Column("stock_no", sa.String(32), nullable=True))

    # 2) 回填存量账号：按 id 升序 KU0001…（与订单号 HS0001 同风格四位流水）。
    rows = bind.execute(text("SELECT id FROM accounts ORDER BY id ASC")).fetchall()
    n = 0
    for (aid,) in rows:
        n += 1
        bind.execute(
            text("UPDATE accounts SET stock_no = :no WHERE id = :id"),
            {"no": f"KU{n:04d}", "id": aid},
        )

    # 3) 序列种子：STOCK_NO（KU / 4 位），current_value 置为已回填条数。
    seq_id = bind.execute(
        text("SELECT COALESCE(MAX(id), 0) + 1 FROM document_sequences")
    ).scalar()
    bind.execute(
        text(
            "INSERT INTO document_sequences "
            "(id, sequence_key, prefix, padding, current_value, created_at, updated_at) "
            "VALUES (:id, 'STOCK_NO', 'KU', 4, :cur, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ),
        {"id": int(seq_id), "cur": n},
    )

    # 4) 建唯一索引（回填后无 NULL、无重复，可安全建）。
    op.create_index("uq_accounts_stock_no", "accounts", ["stock_no"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    op.drop_index("uq_accounts_stock_no", table_name="accounts")
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key = 'STOCK_NO'"))
    op.drop_column("accounts", "stock_no")

