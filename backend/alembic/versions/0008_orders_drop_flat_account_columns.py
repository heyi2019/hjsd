"""0008 orders 去冗余：删除 7 个平铺账号列，账号资料单一事实源 = account_snapshot。

口径（2026-10-28 用户裁决）：
- orders 表的 game_type / game_account / game_password / channel_region /
  bound_phone / has_secondary / account_note 七列为 account_snapshot 的
  物理冗余（同一数据三处存储），全部删除；
- 迁移时先把存量平铺数据折入 account_snapshot（仅限快照为空的行，防数据丢失）；
- 展示与筛选统一走「库存账号实体 → 订单快照」回退链（router 已实现）；
- API 层 OrderCreate 平铺字段保留为入参兼容，service 内部自动转为快照。

downgrade 有损：快照无法反向拆回平铺列，仅重建表结构。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

_REMOVED_COLUMNS = (
    "game_type",
    "game_account",
    "game_password",
    "channel_region",
    "bound_phone",
    "has_secondary",
    "account_note",
)

_FOLD_FLAT_INTO_SNAPSHOT = """
UPDATE orders
SET account_snapshot = json_object(
    'game_account', game_account,
    'game_type', game_type,
    'game_password', game_password,
    'channel_region', channel_region,
    'bound_phone', bound_phone,
    'has_secondary', has_secondary,
    'note', account_note)
WHERE (account_snapshot IS NULL OR account_snapshot = 'null')
  AND game_account IS NOT NULL
"""

_ORDERS_COLUMNS = (
    "id, order_no, order_type, capital_type, trade_date, account_id, status, "
    "policy_version_id, policy_snapshot, link_status, owner_id, note, "
    "created_by, updated_by, created_at, updated_at, commission_mode, commission_payer, "
    "account_snapshot, form_extra"
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
    CONSTRAINT ck_orders_order_account_snapshot_type_valid CHECK (account_snapshot IS NULL OR account_snapshot = 'null' OR order_type IN ('HS', 'TH', 'DG', 'DFQ'))
)"""


def _rebuild_without_flat_columns() -> None:
    op.execute(text(_ORDERS_TABLE_TMPL.format(token="_orders_new_0008")))
    op.execute(
        text(
            f"INSERT INTO _orders_new_0008 ({_ORDERS_COLUMNS}) "
            f"SELECT {_ORDERS_COLUMNS} FROM orders"
        )
    )
    op.execute(text("DROP TABLE orders"))
    op.execute(text("ALTER TABLE _orders_new_0008 RENAME TO orders"))
    for _, ddl in _ORDERS_INDEXES:
        op.execute(text(ddl))


def upgrade() -> None:
    # 1) 存量平铺数据折入快照（仅快照为空且有游戏账号的行），防删列丢数据
    op.execute(text(_FOLD_FLAT_INTO_SNAPSHOT))
    # 2) 重建表删除 7 个平铺列
    _rebuild_without_flat_columns()


def downgrade() -> None:
    # 有损回滚：快照数据不拆回平铺列，仅恢复带平铺列的表结构
    op.execute(
        text(
            _ORDERS_TABLE_TMPL.replace("{token}", "_orders_old_0008").replace(
                "    form_extra JSON,\n",
                "    form_extra JSON,\n"
                "    game_type VARCHAR(64),\n"
                "    game_account VARCHAR(128),\n"
                "    game_password VARCHAR(256),\n"
                "    channel_region VARCHAR(128),\n"
                "    bound_phone VARCHAR(64),\n"
                "    has_secondary BOOLEAN,\n"
                "    account_note TEXT,\n",
            )
        )
    )
    op.execute(
        text(
            f"INSERT INTO _orders_old_0008 ({_ORDERS_COLUMNS}) "
            f"SELECT {_ORDERS_COLUMNS} FROM orders"
        )
    )
    op.execute(text("DROP TABLE orders"))
    op.execute(text("ALTER TABLE _orders_old_0008 RENAME TO orders"))
    for _, ddl in _ORDERS_INDEXES:
        op.execute(text(ddl))

