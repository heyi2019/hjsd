"""rebuild_reconciliations_float_tolerance：对账 CHECK 改为浮点容差比较。

背景：`ck_reconciliations_difference_matches_balances` 在 0001 迁移与 ORM 里都是
严格等式 `difference = statement_balance - system_balance`。SQLite 无原生 DECIMAL，
`Amount`（DECIMAL(18,2)）落库即 REAL，CHECK 表达式按浮点求值；而 Python 侧
`to_money()` 用 Decimal 精确计算。两边在「角分不为零」时必然分叉：

    0.30 - 0.10        = 0.19999999999999998 ≠ 0.20
    123456.78 - 99999.99 = 23456.789999999994 ≠ 23456.79

后果：`POST /reconciliations` 对常见小数余额组合直接 IntegrityError 500
（实测 5 组常见金额 3 组必炸），资金对账在真实数据下不可用。

修复（用户裁决方案 A）：CHECK 改容差
`abs(difference - (statement_balance - system_balance)) <= 0.005`，
语义不变——差值必须等于两余额之差，仅容忍半分钱内的浮点表示误差。
容差取 0.005（半分）：difference 与两余额均为 2 位小数，真实口径偏差只可能
是 0 或 >= 0.01，浮点残差 < 1e-9，半分窗口两者都不会误放行。

SQLite 不支持 ALTER TABLE 改 CHECK，按 ORM/迁移链终态形态（0013 已删
pool_account_id，唯一约束 3 列）整表重建。表被 reporting 只读引用、无子表
外键引用本表，重建无级联风险；迁移引擎已全局关闭外键强制（env.py）。

幂等：先读 sqlite_master 的 DDL，已含容差表达式（`<= 0.005`）或表不存在
都跳过。downgrade 还原严格等式。

Revision ID: c9e2f4a6b8d0
Revises: 0fab9bce97a7
Create Date: 2026-10-27 14:25:00.000000

"""
from __future__ import annotations

from alembic import op
from sqlalchemy.engine import Connection

revision: str = "c9e2f4a6b8d0"
down_revision: str | None = "0fab9bce97a7"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "reconciliations"
TMP = "reconciliations__rebuild"

COLUMNS = (
    "id, pool_id, reconciled_on, account_label, system_balance, statement_balance, "
    "difference, status, reason, unmatched_flow_ids, resolved_by, resolved_at, note, "
    "created_by, updated_by, created_at, updated_at"
)

INDEXES = (
    "CREATE INDEX ix_reconciliations_pool_date ON reconciliations (pool_id, reconciled_on)",
)

# 目标形态 = ORM / 0001+0013 迁移链终态的样子（唯一约束 3 列，CHECK 容差）
_TARGET_DDL = f"""
CREATE TABLE {TMP} (
    id INTEGER NOT NULL,
    pool_id INTEGER NOT NULL,
    reconciled_on DATE NOT NULL,
    account_label VARCHAR(128) NOT NULL,
    system_balance NUMERIC(18, 2) NOT NULL,
    statement_balance NUMERIC(18, 2) NOT NULL,
    difference NUMERIC(18, 2) NOT NULL,
    status VARCHAR(16) NOT NULL,
    reason TEXT,
    unmatched_flow_ids JSON NOT NULL,
    resolved_by VARCHAR(64),
    resolved_at DATETIME,
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    updated_by VARCHAR(64) NOT NULL,
    created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    CONSTRAINT pk_reconciliations PRIMARY KEY (id),
    CONSTRAINT ck_reconciliations_reconciliation_status_valid CHECK (status IN ('OPEN', 'RESOLVED')),
    CONSTRAINT ck_reconciliations_reconciliation_statement_nonneg CHECK (statement_balance >= 0),
    CONSTRAINT ck_reconciliations_difference_matches_balances CHECK (abs(difference - (statement_balance - system_balance)) <= 0.005),
    CONSTRAINT fk_reconciliations_pool_id FOREIGN KEY(pool_id) REFERENCES pools (id) ON DELETE RESTRICT,
    CONSTRAINT uq_reconciliations_scope UNIQUE (pool_id, reconciled_on, account_label)
)
"""

# downgrade 用：还原严格等式形态
_LEGACY_DDL = _TARGET_DDL.replace(
    "CHECK (abs(difference - (statement_balance - system_balance)) <= 0.005)",
    "CHECK (difference = statement_balance - system_balance)",
)


def _current_ddl(bind: Connection) -> str | None:
    row = bind.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (TABLE,)
    ).first()
    return row[0] if row else None


def _has_tolerance(ddl: str) -> bool:
    return "<= 0.005" in " ".join(ddl.split())


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
        raise RuntimeError(f"reconciliations 重建后存在悬空外键：{orphans[:5]}")


def upgrade() -> None:
    ddl = _current_ddl(op.get_bind())
    if ddl is None or _has_tolerance(ddl):
        return
    _rebuild(_TARGET_DDL)


def downgrade() -> None:
    ddl = _current_ddl(op.get_bind())
    if ddl is None or not _has_tolerance(ddl):
        return
    _rebuild(_LEGACY_DDL)
