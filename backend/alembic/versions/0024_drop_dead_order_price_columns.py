"""drop_dead_order_price_columns：删除 orders 的 3 个死列。

背景：`orders.listing_price / service_fee / expected_settlement_date` 是
ORM 有定义（含 2 个 nonneg CHECK）但从未接线的死列——`OrderCreate/OrderOut`
schema 不暴露、service/前端 0 引用、正式库 486 行全 NULL。
分期场景的 `service_fee` 是 `installments.service_fee`（活列，134/134 有值），
与本列无关，勿混淆。保留会持续误导「这列能用」。
`orders.bound_phone / policy_version_id / owner_id` 同为全 NULL 但是
活列（建档写入 / 政策版本联动 / 归属过滤），不在本次范围。

SQLite 不支持 DROP COLUMN 之外的限制：删列虽可用 ALTER TABLE DROP COLUMN，
但同表挂着 2 个引用这些列的 CHECK（ck_orders_listing_price_nonneg /
ck_orders_service_fee_nonneg）必须一并移除，SQLite 拒绝在列被 CHECK
引用时 DROP COLUMN，因此仍走整表重建（同 0021/0022/0023 先例）。

orders 被多张子表以 FK 引用（order_events / installments / cashflow / 
order_links 等），迁移引擎已全局关闭外键强制（env.py），重建期间子表
约束按表名在 RENAME 后自动重新指回，无级联风险。命名索引（6 个）在
RENAME 之后重建（随旧表 DROP 会一并消失）。

幂等：`PRAGMA table_info(orders)` 已无 listing_price 则跳过；表不存在
（裁剪库）也跳过。downgrade 按原形态还原（三列全 NULL 回填）。

Revision ID: d7b9f1a3c5e7
Revises: c9e2f4a6b8d0
Create Date: 2026-10-27 15:00:00.000000

"""
from __future__ import annotations

from alembic import op
from sqlalchemy.engine import Connection

revision: str = "d7b9f1a3c5e7"
down_revision: str | None = "c9e2f4a6b8d0"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "orders"
TMP = "orders__rebuild"

# 升级后（当前 ORM）的列，顺序与 ORM 定义一致
_UP_COLUMNS = [
    "id", "order_no", "order_type", "capital_type", "trade_date", "account_id",
    "status", "policy_version_id", "policy_snapshot", "link_status", "owner_id",
    "note", "created_by", "updated_by", "created_at", "updated_at",
    "commission_mode", "commission_payer", "account_snapshot",
    "game_type", "game_account", "game_password", "channel_region", "bound_phone",
    "has_secondary", "account_note", "form_extra",
]
COLUMNS = ", ".join(_UP_COLUMNS)

# 0024 之前的列序（三列插回原位）；downgrade 复制时对 orders 里已不存在的
# 列一律填 NULL（历史数据三列本来就全 NULL，无损）。
_LEGACY_COLUMNS = (
    _UP_COLUMNS[:16]
    + ["listing_price", "service_fee"]
    + _UP_COLUMNS[16:18]
    + ["expected_settlement_date"]
    + _UP_COLUMNS[18:]
)
LEGACY_INSERT = ", ".join(_LEGACY_COLUMNS)
LEGACY_SELECT = ", ".join(col if col in _UP_COLUMNS else "NULL" for col in _LEGACY_COLUMNS)

# 目标形态 = 0001 迁移链按当前 ORM 建出来的样子（仅去掉 3 个死列与其 2 个 CHECK）
_TARGET_DDL = f"""
CREATE TABLE {TMP} (
    id INTEGER NOT NULL,
    order_no VARCHAR(32) NOT NULL,
    order_type VARCHAR(16) NOT NULL,
    capital_type VARCHAR(16) NOT NULL,
    trade_date DATE NOT NULL,
    account_id INTEGER,
    status VARCHAR(16) NOT NULL,
    policy_version_id INTEGER,
    policy_snapshot JSON,
    link_status VARCHAR(24) NOT NULL,
    owner_id INTEGER,
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    updated_by VARCHAR(64) NOT NULL,
    created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    commission_mode VARCHAR(32),
    commission_payer VARCHAR(16),
    account_snapshot JSON,
    game_type VARCHAR(64),
    game_account VARCHAR(128),
    game_password VARCHAR(256),
    channel_region VARCHAR(128),
    bound_phone VARCHAR(64),
    has_secondary BOOLEAN,
    account_note TEXT,
    form_extra JSON,
    CONSTRAINT pk_orders PRIMARY KEY (id),
    CONSTRAINT uq_orders_no UNIQUE (order_no),
    CONSTRAINT fk_orders_account_id FOREIGN KEY(account_id) REFERENCES accounts (id) ON DELETE SET NULL,
    CONSTRAINT fk_orders_owner_id FOREIGN KEY(owner_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_orders_policy_version_id FOREIGN KEY(policy_version_id) REFERENCES policy_versions (id) ON DELETE SET NULL,
    CONSTRAINT ck_orders_order_status_valid CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT ck_orders_order_capital_type_valid CHECK (capital_type IN ('STOCK', 'ZERO', 'CREDIT')),
    CONSTRAINT ck_orders_order_link_status_valid CHECK (link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')),
    CONSTRAINT ck_orders_order_commission_mode_valid CHECK (commission_mode IS NULL OR commission_mode IN ('DEDUCT_FROM_SETTLEMENT', 'SEPARATE_PAYMENT')),
    CONSTRAINT ck_orders_order_commission_payer_valid CHECK (commission_payer IS NULL OR commission_payer IN ('BUYER', 'CONSIGNOR', 'PLATFORM')),
    CONSTRAINT ck_orders_order_commission_pair_valid CHECK ((commission_mode IS NULL) = (commission_payer IS NULL)),
    CONSTRAINT ck_orders_order_commission_type_valid CHECK (order_type = 'DG' OR (commission_mode IS NULL AND commission_payer IS NULL)),
    CONSTRAINT ck_orders_order_account_snapshot_type_valid CHECK (order_type = 'DFQ' OR account_snapshot IS NULL OR account_snapshot = 'null')
)
"""

# downgrade 用：还原成 0024 之前的形态（含 3 个死列与 2 个 nonneg CHECK）
_LEGACY_DDL = f"""
CREATE TABLE {TMP} (
    id INTEGER NOT NULL,
    order_no VARCHAR(32) NOT NULL,
    order_type VARCHAR(16) NOT NULL,
    capital_type VARCHAR(16) NOT NULL,
    trade_date DATE NOT NULL,
    account_id INTEGER,
    status VARCHAR(16) NOT NULL,
    policy_version_id INTEGER,
    policy_snapshot JSON,
    link_status VARCHAR(24) NOT NULL,
    owner_id INTEGER,
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    updated_by VARCHAR(64) NOT NULL,
    created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    listing_price NUMERIC(18, 2),
    service_fee NUMERIC(18, 2),
    commission_mode VARCHAR(32),
    commission_payer VARCHAR(16),
    expected_settlement_date DATE,
    account_snapshot JSON,
    game_type VARCHAR(64),
    game_account VARCHAR(128),
    game_password VARCHAR(256),
    channel_region VARCHAR(128),
    bound_phone VARCHAR(64),
    has_secondary BOOLEAN,
    account_note TEXT,
    form_extra JSON,
    CONSTRAINT pk_orders PRIMARY KEY (id),
    CONSTRAINT uq_orders_no UNIQUE (order_no),
    CONSTRAINT fk_orders_account_id FOREIGN KEY(account_id) REFERENCES accounts (id) ON DELETE SET NULL,
    CONSTRAINT fk_orders_owner_id FOREIGN KEY(owner_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_orders_policy_version_id FOREIGN KEY(policy_version_id) REFERENCES policy_versions (id) ON DELETE SET NULL,
    CONSTRAINT ck_orders_order_status_valid CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT ck_orders_order_capital_type_valid CHECK (capital_type IN ('STOCK', 'ZERO', 'CREDIT')),
    CONSTRAINT ck_orders_order_link_status_valid CHECK (link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')),
    CONSTRAINT ck_orders_order_commission_mode_valid CHECK (commission_mode IS NULL OR commission_mode IN ('DEDUCT_FROM_SETTLEMENT', 'SEPARATE_PAYMENT')),
    CONSTRAINT ck_orders_order_commission_payer_valid CHECK (commission_payer IS NULL OR commission_payer IN ('BUYER', 'CONSIGNOR', 'PLATFORM')),
    CONSTRAINT ck_orders_order_commission_pair_valid CHECK ((commission_mode IS NULL) = (commission_payer IS NULL)),
    CONSTRAINT ck_orders_listing_price_nonneg CHECK (listing_price IS NULL OR listing_price >= 0),
    CONSTRAINT ck_orders_service_fee_nonneg CHECK (service_fee IS NULL OR service_fee >= 0),
    CONSTRAINT ck_orders_order_commission_type_valid CHECK (order_type = 'DG' OR (commission_mode IS NULL AND commission_payer IS NULL)),
    CONSTRAINT ck_orders_order_account_snapshot_type_valid CHECK (order_type = 'DFQ' OR account_snapshot IS NULL OR account_snapshot = 'null')
)
"""

_INDEXES = (
    "CREATE INDEX ix_orders_owner_id ON orders (owner_id)",
    "CREATE INDEX ix_orders_trade_date ON orders (trade_date)",
    "CREATE INDEX ix_orders_link_status ON orders (link_status)",
    "CREATE INDEX ix_orders_policy_version_id ON orders (policy_version_id)",
    "CREATE INDEX ix_orders_account_id ON orders (account_id)",
    "CREATE INDEX ix_orders_type_date ON orders (order_type, trade_date)",
)


def _table_exists(bind: Connection) -> bool:
    row = bind.exec_driver_sql(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (TABLE,)
    ).first()
    return row is not None


def _has_dead_columns(bind: Connection) -> bool:
    """upgrade 判据：listing_price 仍在（三列同生共死）。"""
    return any(
        row[1] == "listing_price"
        for row in bind.exec_driver_sql(f"PRAGMA table_info({TABLE})").fetchall()
    )


def _rebuild(ddl: str, insert_cols: str, select_exprs: str) -> None:
    bind = op.get_bind()
    if not _table_exists(bind):
        return
    op.execute(f"DROP TABLE IF EXISTS {TMP}")
    op.execute(ddl)
    op.execute(f"INSERT INTO {TMP} ({insert_cols}) SELECT {select_exprs} FROM {TABLE}")
    op.execute(f"DROP TABLE {TABLE}")
    op.execute(f"ALTER TABLE {TMP} RENAME TO {TABLE}")
    # 命名索引随旧表一起消失，必须在 RENAME 之后按新表名重建。
    for index_ddl in _INDEXES:
        op.execute(index_ddl)


def upgrade() -> None:
    if not _has_dead_columns(op.get_bind()):
        return
    _rebuild(_TARGET_DDL, COLUMNS, COLUMNS)


def downgrade() -> None:
    if _has_dead_columns(op.get_bind()):
        return
    _rebuild(_LEGACY_DDL, LEGACY_INSERT, LEGACY_SELECT)
