"""0010 放开 game_account 唯一约束：支持复购（2026-10-28 用户裁决）。

口径：
- game_account 不唯一——同一游戏账号可反复回购（像车一样不停回购），
  每次收购都是独立库存实体，各自成本与生命周期；
- stocks 表整表重建，删除 uq_accounts_game_account 约束（SQLite 无法
  直接 DROP CONSTRAINT），其余列/CHECK/索引原样保留；
- service 层查重同步移除（stocks/profile.py 建号与改名、
  installments/service.py 物化挂靠改按 order.account_id 归属）。

downgrade 反向重建（恢复唯一约束；若届时存在重复 game_account 会失败）。
"""
from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

_STOCKS_DDL = """CREATE TABLE {token} (
	id INTEGER NOT NULL,
	game_type VARCHAR(64),
	business_mode VARCHAR(24),
	inventory_type VARCHAR(24),
	game_account VARCHAR(128),
	game_password VARCHAR(256),
	channel_region VARCHAR(128),
	bound_phone VARCHAR(64),
	has_secondary BOOLEAN,
	platform VARCHAR(64),
	status VARCHAR(16) NOT NULL,
	buy_date DATE,
	cost_amount NUMERIC(18, 2) NOT NULL,
	note TEXT,
	created_by VARCHAR(64) NOT NULL,
	updated_by VARCHAR(64) NOT NULL,
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	account_description TEXT,
	account_images JSON, form_extra JSON, value_added_service VARCHAR(32), stock_no VARCHAR(32),
	CONSTRAINT pk_accounts PRIMARY KEY (id),
	CONSTRAINT ck_accounts_account_inventory_type_valid CHECK (inventory_type IS NULL OR inventory_type IN ('RECOVERY', 'PICKUP', 'CONSIGNMENT')),
	CONSTRAINT ck_accounts_account_business_mode_valid CHECK (business_mode IS NULL OR business_mode IN ('SELF', 'DISTRIBUTION')),
	CONSTRAINT ck_accounts_account_status_valid CHECK (status IN ('IN_STOCK', 'INSTALLMENT', 'SOLD', 'VOID')),
	CONSTRAINT ck_accounts_cost_nonneg CHECK (cost_amount >= 0),
	CONSTRAINT ck_accounts_account_inventory_context_valid CHECK (business_mode IS NULL OR inventory_type IS NULL OR (business_mode = 'SELF' AND inventory_type = 'RECOVERY') OR (business_mode = 'DISTRIBUTION' AND inventory_type IN ('PICKUP', 'CONSIGNMENT')))
)"""

_STOCKS_DDL_WITH_UNIQUE = _STOCKS_DDL.replace(
    "\tCONSTRAINT ck_accounts_account_status_valid",
    "\tCONSTRAINT uq_accounts_game_account UNIQUE (game_account),\n"
    "\tCONSTRAINT ck_accounts_account_status_valid",
)

_INDEXES = (
    "CREATE UNIQUE INDEX uq_accounts_stock_no ON {token} (stock_no)",
    "CREATE INDEX ix_stocks_status ON {token} (status)",
)


def _rebuild(ddl: str) -> None:
    op.execute(ddl.replace("{token}", "stocks_new"))
    op.execute(
        "INSERT INTO stocks_new (id, game_type, business_mode, inventory_type, "
        "game_account, game_password, channel_region, bound_phone, has_secondary, "
        "platform, status, buy_date, cost_amount, note, created_by, updated_by, "
        "created_at, updated_at, account_description, account_images, form_extra, "
        "value_added_service, stock_no) "
        "SELECT id, game_type, business_mode, inventory_type, game_account, "
        "game_password, channel_region, bound_phone, has_secondary, platform, "
        "status, buy_date, cost_amount, note, created_by, updated_by, created_at, "
        "updated_at, account_description, account_images, form_extra, "
        "value_added_service, stock_no FROM stocks"
    )
    op.execute("DROP TABLE stocks")
    op.execute("ALTER TABLE stocks_new RENAME TO stocks")
    for index_sql in _INDEXES:
        op.execute(index_sql.replace("{token}", "stocks"))


def upgrade() -> None:
    _rebuild(_STOCKS_DDL)


def downgrade() -> None:
    _rebuild(_STOCKS_DDL_WITH_UNIQUE)

