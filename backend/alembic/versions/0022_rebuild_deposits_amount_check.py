"""rebuild_deposits_amount_check：重建 deposits 表补回 lost_amount 的非负约束。

背景：`ck_deposits_amount_nonneg` 在 0001 迁移与 ORM（`app/domain/trade.py`
`Deposit.__table_args__` 的 `amount_nonneg`）里都是
`paid_amount >= 0 AND returned_amount >= 0 AND lost_amount >= 0`，但正式库这张表
是 `lost_amount` 列加入之前的旧版本，CHECK 里**只有前两项**。

后果：负的 `lost_amount` 能直接写进去（`ck_deposits_released_amount_within_paid`
只限制 returned + lost <= paid，不防负数），押金"已损失金额"可被写成负值从而
反向虚增可退金额。数据面当前 25 行、0 负值，属结构缺口而非既成脏数据。

SQLite 不支持 ALTER TABLE 改 CHECK，按 ORM/迁移链形态整表重建。表被
`cashflow.deposit_id`（ON DELETE SET NULL）引用，故重建走 SQLite 官方的
「新表 → 拷数据 → 删旧表 → 改名 → 重建索引 → foreign_key_check」顺序，
迁移引擎已全局关闭外键强制（env.py），改名不会被悬空引用卡住。

幂等：先读 sqlite_master 的 DDL，已含 `lost_amount >= 0` 或表不存在都跳过。
downgrade 还原旧形态（CHECK 不含 lost_amount）。

Revision ID: 0fab9bce97a7
Revises: fad42e66db1a
Create Date: 2026-10-27 13:40:00.000000

"""
from __future__ import annotations

import re

from alembic import op
from sqlalchemy.engine import Connection

revision: str = "0fab9bce97a7"
down_revision: str | None = "fad42e66db1a"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "deposits"
TMP = "deposits__rebuild"

COLUMNS = (
    "id, pool_id, counterparty_id, source_order_id, paid_amount, returned_amount, "
    "lost_amount, status, paid_on, expected_release_on, released_on, lost_on, note, "
    "created_by, updated_by, created_at, updated_at"
)

INDEXES = (
    "CREATE INDEX ix_deposits_counterparty_id ON deposits (counterparty_id)",
    "CREATE INDEX ix_deposits_source_order_id ON deposits (source_order_id)",
    "CREATE INDEX ix_deposits_pool_id ON deposits (pool_id)",
)

# 目标形态 = ORM / 0001 迁移链产物的样子（含 lost_amount 非负）
_TARGET_DDL = f"""
CREATE TABLE {TMP} (
    id INTEGER NOT NULL,
    pool_id INTEGER NOT NULL,
    counterparty_id INTEGER,
    source_order_id INTEGER,
    paid_amount NUMERIC(18, 2) NOT NULL,
    returned_amount NUMERIC(18, 2) NOT NULL,
    lost_amount NUMERIC(18, 2) DEFAULT '0' NOT NULL,
    status VARCHAR(24) NOT NULL,
    paid_on DATE NOT NULL,
    expected_release_on DATE,
    released_on DATE,
    lost_on DATE,
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    updated_by VARCHAR(64) NOT NULL,
    created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    CONSTRAINT pk_deposits PRIMARY KEY (id),
    CONSTRAINT ck_deposits_deposit_status_valid CHECK (status IN ('PAID', 'PARTIALLY_RETURNED', 'RETURNED', 'LOST', 'CANCELLED')),
    CONSTRAINT ck_deposits_amount_nonneg CHECK (paid_amount >= 0 AND returned_amount >= 0 AND lost_amount >= 0),
    CONSTRAINT ck_deposits_released_amount_within_paid CHECK (returned_amount + lost_amount <= paid_amount),
    CONSTRAINT fk_deposits_counterparty_id FOREIGN KEY(counterparty_id) REFERENCES counterparties (id) ON DELETE SET NULL,
    CONSTRAINT fk_deposits_pool_id FOREIGN KEY(pool_id) REFERENCES pools (id) ON DELETE RESTRICT,
    CONSTRAINT fk_deposits_source_order_id FOREIGN KEY(source_order_id) REFERENCES orders (id) ON DELETE SET NULL
)
"""

# 还原用：正式库原有形态（CHECK 缺 lost_amount）
_LEGACY_DDL = _TARGET_DDL.replace(
    "paid_amount >= 0 AND returned_amount >= 0 AND lost_amount >= 0",
    "paid_amount >= 0 AND returned_amount >= 0",
)


def _current_ddl(bind: Connection) -> str | None:
    row = bind.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (TABLE,)
    ).first()
    return row[0] if row else None


def _has_lost_check(ddl: str) -> bool:
    return "lost_amount >= 0" in re.sub(r"\s+", " ", ddl)


def _rebuild(ddl: str) -> None:
    bind = op.get_bind()
    op.execute(f"DROP TABLE IF EXISTS {TMP}")
    op.execute(ddl)
    op.execute(f"INSERT INTO {TMP} ({COLUMNS}) SELECT {COLUMNS} FROM {TABLE}")
    op.execute(f"DROP TABLE {TABLE}")
    op.execute(f"ALTER TABLE {TMP} RENAME TO {TABLE}")
    for stmt in INDEXES:
        op.execute(stmt)
    orphans = bind.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if orphans:
        raise RuntimeError(f"deposits 重建后存在悬空外键：{orphans[:5]}")


def upgrade() -> None:
    ddl = _current_ddl(op.get_bind())
    if ddl is None or _has_lost_check(ddl):
        return
    _rebuild(_TARGET_DDL)


def downgrade() -> None:
    ddl = _current_ddl(op.get_bind())
    if ddl is None or not _has_lost_check(ddl):
        return
    _rebuild(_LEGACY_DDL)
