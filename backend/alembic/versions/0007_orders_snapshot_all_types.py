"""0007 orders 快照 CHECK 放宽：account_snapshot 四类业务通用（2026-10-28 用户裁决）。

口径：
- 建单账号资料统一走 account_snapshot（HS/TH/DG 与 DFQ 对齐），建单成功即内联建库存账号；
- orders 表 CHECK `ck_orders_order_account_snapshot_type_valid` 由「仅 DFQ 可有快照」
  放宽为「快照仅限 HS/TH/DG/DFQ 四类业务，自定义业务类型不可有快照」；
- SQLite 无法 ALTER CHECK，按「建新表→拷→删→改名」整表重建；命名索引在 RENAME 之后建；
- 服务层校验（create_order 互斥/类型白名单）为第一道关口，本 CHECK 为库层兜底。

downgrade 重建回原 CHECK（仅 DFQ 可有快照）——若 downgrade 时存在非 DFQ 快照数据，
将因回拷违反 CHECK 失败，属预期有损回滚。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

_ORDERS_COLUMNS = (
    "id, order_no, order_type, capital_type, trade_date, account_id, status, "
    "policy_version_id, policy_snapshot, link_status, owner_id, note, "
    "created_by, updated_by, created_at, updated_at, commission_mode, commission_payer, "
    "account_snapshot, game_type, game_account, game_password, channel_region, "
    "bound_phone, has_secondary, account_note, form_extra"
)

_ORDERS_INDEXES = (
    ("ix_orders_owner_id", "CREATE INDEX ix_orders_owner_id ON orders (owner_id)"),
    ("ix_orders_trade_date", "CREATE INDEX ix_orders_trade_date ON orders (trade_date)"),
    ("ix_orders_link_status", "CREATE INDEX ix_orders_link_status ON orders (link_status)"),
    (
        "ix_orders_policy_version_id",
        "CREATE INDEX ix_orders_policy_version_id ON orders (policy_version_id)",
    ),
    ("ix_orders_account_id", "CREATE INDEX ix_orders_account_id ON orders (account_id)"),
    (
        "ix_orders_type_date",
        "CREATE INDEX ix_orders_type_date ON orders (order_type, trade_date)",
    ),
)

_ORDERS_TABLE_TMPL = """CREATE TABLE {token} (
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
    CONSTRAINT ck_orders_order_account_snapshot_type_valid CHECK ({snapshot_check})
)"""

_SNAPSHOT_CHECK_NEW = (
    "account_snapshot IS NULL OR account_snapshot = 'null' "
    "OR order_type IN ('HS', 'TH', 'DG', 'DFQ')"
)
_SNAPSHOT_CHECK_OLD = (
    "order_type = 'DFQ' OR account_snapshot IS NULL OR account_snapshot = 'null'"
)


def _rebuild(snapshot_check: str) -> None:
    op.execute(text(_ORDERS_TABLE_TMPL.format(token="_orders_new_0007", snapshot_check=snapshot_check)))
    op.execute(
        text(
            f"INSERT INTO _orders_new_0007 ({_ORDERS_COLUMNS}) "
            f"SELECT {_ORDERS_COLUMNS} FROM orders"
        )
    )
    op.execute(text("DROP TABLE orders"))
    op.execute(text("ALTER TABLE _orders_new_0007 RENAME TO orders"))
    for _, ddl in _ORDERS_INDEXES:
        op.execute(text(ddl))


def upgrade() -> None:
    _rebuild(_SNAPSHOT_CHECK_NEW)


def downgrade() -> None:
    _rebuild(_SNAPSHOT_CHECK_OLD)
