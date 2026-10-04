"""M5：经营规则版本化与快照固化（T19 / T20，BAS-06-01~04）。

核心红线（BAS-06-04）：
> 订单、合约、返点、流水必须保留实际规则快照；改未来费率不会改写已发生订单的利润

实现：给 orders / installments / rebate_records 各加
`policy_version_id`（引用当时生效的规则版本）+ `policy_snapshot`（JSON 固化参数）。
规则改版**不回写**这些字段，历史利润永远按当时口径。

SQLite 约束（本项目已踩坑确认，务必先读）：
- 不支持 `ALTER TABLE ADD CONSTRAINT`，改 CHECK / 加外键必须「建新表→拷贝→删→改名」；
- `ALTER TABLE ADD COLUMN` **不能带外键**，所以三张业务表要整表重建；
- 重建 `policy_versions` 会让引用它的 `order_profit_allocations` 外键指向 `_old` 表，
  必须一并重建；
- 直连 `op.get_bind().engine.connect()` 会 `database is locked`，
  所有 DDL 一律走 `op.execute`；
- DDL 模板插值必须用 `.replace()`，**不能用 `.format()`**（会吃掉其他花括号）。

revision: 0005_m5_policy_snapshot
down_revision: 0004_m4_history_closure
"""
from __future__ import annotations

import sqlalchemy as sa  # noqa: F401  (保留给后续版本使用)
from alembic import op

revision = "0005_m5_policy_snapshot"
down_revision = "0004_m4_history_closure"

# 关键：这些常量是插进 `CHECK (col IN <常量>)` 的，**必须自带外层括号**。
# 少了括号就是 `IN 'A', 'B'` → sqlite3.OperationalError: near ","（0004/0005 各踩一次）。
_ORDER_STATUS = "('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED')"
_CAPITAL_TYPE = "('STOCK', 'PASS_THRU', 'ZERO', 'CREDIT')"
_CONTRACT_TYPES = "('STOCK_SALE', 'ADVANCE_PURCHASE')"
_INST_STATUS = "('PENDING', 'ACTIVE', 'OVERDUE', 'SETTLED', 'DELIVERED', 'DEFAULTED', 'CANCELLED')"
_REBATE_STATUS = "('OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'VOID')"
_POLICY_STATUS_V2 = "('DRAFT', 'ACTIVE', 'EXPIRED', 'SUPERSEDED')"
_POLICY_STATUS_V1 = "('DRAFT', 'ACTIVE', 'EXPIRED')"

_ORDERS_DDL = """
CREATE TABLE orders (
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_orders PRIMARY KEY (id),
    CONSTRAINT ck_orders_order_status_valid CHECK (status IN {order_status}),
    CONSTRAINT ck_orders_order_capital_type_valid CHECK (capital_type IN {capital_type}),
    CONSTRAINT fk_orders_account_id FOREIGN KEY (account_id)
        REFERENCES accounts (id) ON DELETE SET NULL,
    CONSTRAINT fk_orders_policy_version_id FOREIGN KEY (policy_version_id)
        REFERENCES policy_versions (id) ON DELETE SET NULL,
    CONSTRAINT uq_orders_no UNIQUE (order_no)
)
"""

_INSTALLMENTS_DDL = """
CREATE TABLE installments (
    id INTEGER NOT NULL,
    inst_no VARCHAR(32) NOT NULL,
    order_id INTEGER NOT NULL,
    account_id INTEGER,
    contract_type VARCHAR(24) NOT NULL,
    policy_version_id INTEGER,
    policy_snapshot JSON,
    principal NUMERIC(18, 2) NOT NULL,
    down_payment NUMERIC(18, 2) NOT NULL,
    periods INTEGER NOT NULL,
    per_period NUMERIC(18, 2) NOT NULL,
    paid_amount NUMERIC(18, 2) NOT NULL,
    status VARCHAR(16) NOT NULL,
    delivery_mode VARCHAR(24),
    delivered_on DATE,
    first_due_on DATE,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_installments PRIMARY KEY (id),
    CONSTRAINT ck_installments_installment_contract_valid
        CHECK (contract_type IN {contract_types}),
    CONSTRAINT ck_installments_installment_status_valid CHECK (status IN {inst_status}),
    CONSTRAINT fk_installments_order_id FOREIGN KEY (order_id)
        REFERENCES orders (id) ON DELETE RESTRICT,
    CONSTRAINT fk_installments_account_id FOREIGN KEY (account_id)
        REFERENCES accounts (id) ON DELETE SET NULL,
    CONSTRAINT fk_installments_policy_version_id FOREIGN KEY (policy_version_id)
        REFERENCES policy_versions (id) ON DELETE SET NULL,
    CONSTRAINT uq_installments_no UNIQUE (inst_no),
    CONSTRAINT uq_installments_order UNIQUE (order_id)
)
"""

_REBATES_DDL = """
CREATE TABLE rebate_records (
    id INTEGER NOT NULL,
    rebate_group_no VARCHAR(32) NOT NULL,
    source_order_id INTEGER,
    channel VARCHAR(64),
    rate NUMERIC(18, 2) NOT NULL,
    base_amount NUMERIC(18, 2) NOT NULL,
    policy_version_id INTEGER,
    policy_snapshot JSON,
    link_status VARCHAR(24) NOT NULL,
    status VARCHAR(24) NOT NULL,
    collected_on DATE NOT NULL,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_rebate_records PRIMARY KEY (id),
    CONSTRAINT ck_rebate_records_rebate_status_valid CHECK (status IN {rebate_status}),
    CONSTRAINT fk_rebate_records_source_order_id FOREIGN KEY (source_order_id)
        REFERENCES orders (id) ON DELETE SET NULL,
    CONSTRAINT fk_rebate_records_policy_version_id FOREIGN KEY (policy_version_id)
        REFERENCES policy_versions (id) ON DELETE SET NULL,
    CONSTRAINT uq_rebate_records_no UNIQUE (rebate_group_no)
)
"""

_ALLOCATIONS_DDL = """
CREATE TABLE order_profit_allocations (
    id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role VARCHAR(32) NOT NULL,
    allocation_rate NUMERIC(18, 2) NOT NULL,
    policy_version_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_order_profit_allocations PRIMARY KEY (id),
    CONSTRAINT fk_order_profit_allocations_order_id FOREIGN KEY (order_id)
        REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_order_profit_allocations_policy_version_id FOREIGN KEY (policy_version_id)
        REFERENCES policy_versions (id) ON DELETE SET NULL,
    CONSTRAINT uq_order_profit_alloc UNIQUE (order_id, user_id, role)
)
"""

_POLICY_DEFS_DDL = """
CREATE TABLE policy_definitions (
    id INTEGER NOT NULL,
    policy_code VARCHAR(32) NOT NULL,
    name VARCHAR(128) NOT NULL,
    scope_type VARCHAR(32) DEFAULT 'GLOBAL' NOT NULL,
    scope_id INTEGER,
    description TEXT,
    status VARCHAR(16) DEFAULT 'DRAFT' NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_policy_definitions PRIMARY KEY (id),
    CONSTRAINT ck_policy_definitions_policy_status_valid CHECK (status IN {status}),
    CONSTRAINT uq_policy_definitions_code UNIQUE (policy_code)
)
"""

_POLICY_VERSIONS_DDL = """
CREATE TABLE policy_versions (
    id INTEGER NOT NULL,
    policy_definition_id INTEGER NOT NULL,
    version INTEGER DEFAULT 1 NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE,
    config JSON NOT NULL,
    status VARCHAR(16) DEFAULT 'DRAFT' NOT NULL,
    approved_by VARCHAR(64),
    approved_at DATETIME,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_policy_versions PRIMARY KEY (id),
    CONSTRAINT fk_policy_versions_policy_definition_id FOREIGN KEY (policy_definition_id)
        REFERENCES policy_definitions (id) ON DELETE RESTRICT,
    CONSTRAINT uq_policy_versions_scope UNIQUE (policy_definition_id, version, effective_from)
)
"""

_DDLS = {
    "orders": _ORDERS_DDL,
    "installments": _INSTALLMENTS_DDL,
    "rebate_records": _REBATES_DDL,
    "order_profit_allocations": _ALLOCATIONS_DDL,
    "policy_definitions": _POLICY_DEFS_DDL,
    "policy_versions": _POLICY_VERSIONS_DDL,
}

# 拷贝列清单：左=旧表实际有的列，右=新表完整列序（只搬运左侧存在的列）
_COPY: dict[str, tuple[str, str]] = {
    "orders": (
        "id, order_no, order_type, capital_type, trade_date, account_id, status, link_status, "
        "owner_id, note, created_at, updated_at, created_by, updated_by",
        "id, order_no, order_type, capital_type, trade_date, account_id, status, policy_version_id, "
        "policy_snapshot, link_status, owner_id, note, created_at, updated_at, created_by, updated_by",
    ),
    "installments": (
        "id, inst_no, order_id, account_id, contract_type, principal, down_payment, periods, "
        "per_period, paid_amount, status, delivery_mode, delivered_on, first_due_on, note, "
        "created_at, updated_at, created_by, updated_by",
        "id, inst_no, order_id, account_id, contract_type, policy_version_id, policy_snapshot, "
        "principal, down_payment, periods, per_period, paid_amount, status, delivery_mode, "
        "delivered_on, first_due_on, note, created_at, updated_at, created_by, updated_by",
    ),
    "rebate_records": (
        "id, rebate_group_no, source_order_id, channel, rate, base_amount, status, link_status, "
        "collected_on, note, created_at, updated_at, created_by, updated_by",
        "id, rebate_group_no, source_order_id, channel, rate, base_amount, "
        "policy_version_id, policy_snapshot, link_status, status, collected_on, note, "
        "created_at, updated_at, created_by, updated_by",
    ),
    "order_profit_allocations": (
        "id, order_id, user_id, role, allocation_rate, policy_version_id, created_at, updated_at",
        "id, order_id, user_id, role, allocation_rate, policy_version_id, created_at, updated_at",
    ),
    "policy_definitions": (
        "id, policy_code, name, scope_type, scope_id, description, status, "
        "created_at, updated_at, created_by, updated_by",
        "id, policy_code, name, scope_type, scope_id, description, status, "
        "created_at, updated_at, created_by, updated_by",
    ),
    "policy_versions": (
        "id, policy_definition_id, version, effective_from, effective_to, config, status, "
        "approved_by, approved_at, note, created_at, updated_at, created_by, updated_by",
        "id, policy_definition_id, version, effective_from, effective_to, config, status, "
        "approved_by, approved_at, note, created_at, updated_at, created_by, updated_by",
    ),
}

_INDEXES: dict[str, list[str]] = {
    "orders": [
        "CREATE INDEX ix_orders_type_date ON orders (order_type, trade_date)",
        "CREATE INDEX ix_orders_link_status ON orders (link_status)",
    ],
    "installments": [
        "CREATE INDEX ix_installments_status ON installments (status, first_due_on)"
    ],
    "rebate_records": ["CREATE INDEX ix_rebate_source_order ON rebate_records (source_order_id)"],
    "order_profit_allocations": [],
    "policy_definitions": [],
    "policy_versions": [],
}

# ── 引用方表 ────────────────────────────────────────────────────
# SQLite 的 `ALTER TABLE ... RENAME TO __old` 会**级联改写引用方的外键**，
# 让它们指向 `orders__old` / `installments__old` / `rebate_records__old`。
# 被这三张表引用的表必须跟着重建，否则 alembic check 报 remove_fk/add_fk 差异，
# 且运行期外键会指向不存在的表。
_REFERENCERS: dict[str, list[str]] = {
    # cashflow 引用 order_events，order_events 会被重建 → 也要跟着重建（传递性）
    "orders": ["deposits", "import_rows", "order_events", "cashflow"],
    "installments": ["installment_schedules"],
    "rebate_records": ["rebate_settlements"],
}

_DEPOSIT_STATUS = "('HELD', 'PARTIALLY_RETURNED', 'RETURNED')"
_ROW_STATUSES = "('PENDING', 'MAPPED', 'UNMAPPED', 'IMPORTED', 'SKIPPED', 'ROLLED_BACK')"
_EVENT_TYPES = "('BUY', 'SELL', 'COST', 'PAYMENT', 'DELIVER', 'TRANSFER', 'CANCEL')"
_PORTIONS = "('PRINCIPAL', 'PROFIT', 'GROSS')"
_NATURES = "('BUSINESS_IN', 'BUSINESS_OUT', 'INTERNAL', 'INVEST', 'FINANCE')"
_DIRECTIONS = "('IN', 'OUT')"

_REFERENCER_DDL: dict[str, str] = {
    "deposits": """
CREATE TABLE deposits (
    id INTEGER NOT NULL,
    deposit_no VARCHAR(32) NOT NULL,
    pool_id INTEGER NOT NULL,
    counterparty_id INTEGER,
    source_order_id INTEGER,
    paid_amount NUMERIC(18, 2) NOT NULL,
    returned_amount NUMERIC(18, 2) NOT NULL,
    status VARCHAR(24) NOT NULL,
    paid_on DATE NOT NULL,
    expected_release_on DATE,
    released_on DATE,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_deposits PRIMARY KEY (id),
    CONSTRAINT ck_deposits_status_valid CHECK (status IN {deposit_status}),
    CONSTRAINT fk_deposits_pool_id FOREIGN KEY (pool_id)
        REFERENCES pools (id) ON DELETE RESTRICT,
    CONSTRAINT fk_deposits_counterparty_id FOREIGN KEY (counterparty_id)
        REFERENCES counterparties (id) ON DELETE SET NULL,
    CONSTRAINT fk_deposits_source_order_id FOREIGN KEY (source_order_id)
        REFERENCES orders (id) ON DELETE SET NULL,
    CONSTRAINT uq_deposits_no UNIQUE (deposit_no)
)
""",
    "import_rows": """
CREATE TABLE import_rows (
    id INTEGER NOT NULL,
    batch_id INTEGER NOT NULL,
    row_no INTEGER NOT NULL,
    raw JSON NOT NULL,
    mapped_order_id INTEGER,
    mapped_account_id INTEGER,
    mapped_by VARCHAR(64),
    mapped_at DATETIME,
    mapping_basis TEXT,
    mapped_before JSON,
    status VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
    unlinked_transfer BOOLEAN DEFAULT 0 NOT NULL,
    issue_note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_import_rows PRIMARY KEY (id),
    CONSTRAINT ck_import_rows_status_valid CHECK (status IN {row_statuses}),
    CONSTRAINT fk_import_rows_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON DELETE CASCADE,
    CONSTRAINT fk_import_rows_mapped_order_id FOREIGN KEY (mapped_order_id)
        REFERENCES orders (id) ON DELETE SET NULL,
    CONSTRAINT fk_import_rows_mapped_account_id FOREIGN KEY (mapped_account_id)
        REFERENCES accounts (id) ON DELETE SET NULL
)
""",
    "order_events": """
CREATE TABLE order_events (
    id INTEGER NOT NULL,
    event_no VARCHAR(32) NOT NULL,
    order_id INTEGER NOT NULL,
    event_type VARCHAR(16) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    portion VARCHAR(16) NOT NULL,
    occurred_on DATE NOT NULL,
    pool_id INTEGER,
    offset_event_id INTEGER,
    delivery_mode VARCHAR(24),
    is_posted BOOLEAN NOT NULL,
    posted_at DATETIME,
    reason TEXT,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_order_events PRIMARY KEY (id),
    CONSTRAINT ck_order_events_type_valid CHECK (event_type IN {event_type}),
    CONSTRAINT ck_order_events_portion_valid CHECK (portion IN {portion}),
    CONSTRAINT fk_order_events_order_id FOREIGN KEY (order_id)
        REFERENCES orders (id) ON DELETE RESTRICT,
    CONSTRAINT fk_order_events_pool_id FOREIGN KEY (pool_id)
        REFERENCES pools (id) ON DELETE RESTRICT,
    CONSTRAINT fk_order_events_offset_event_id FOREIGN KEY (offset_event_id)
        REFERENCES order_events (id) ON DELETE SET NULL,
    CONSTRAINT uq_order_events_no UNIQUE (event_no)
)
""",
    "installment_schedules": """
CREATE TABLE installment_schedules (
    id INTEGER NOT NULL,
    installment_id INTEGER NOT NULL,
    period_no INTEGER NOT NULL,
    due_on DATE NOT NULL,
    due_amount NUMERIC(18, 2) NOT NULL,
    received_amount NUMERIC(18, 2) NOT NULL,
    received_on DATE,
    status VARCHAR(16) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_installment_schedules PRIMARY KEY (id),
    CONSTRAINT fk_installment_schedules_installment_id FOREIGN KEY (installment_id)
        REFERENCES installments (id) ON DELETE CASCADE,
    CONSTRAINT uq_installment_period UNIQUE (installment_id, period_no)
)
""",
    "rebate_settlements": """
CREATE TABLE rebate_settlements (
    id INTEGER NOT NULL,
    settlement_no VARCHAR(48) NOT NULL,
    rebate_record_id INTEGER NOT NULL,
    settled_on DATE NOT NULL,
    gross_amount NUMERIC(18, 2) NOT NULL,
    platform_fee NUMERIC(18, 2) NOT NULL,
    net_amount NUMERIC(18, 2) NOT NULL,
    cashflow_id INTEGER,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_rebate_settlements PRIMARY KEY (id),
    CONSTRAINT fk_rebate_settlements_rebate_record_id FOREIGN KEY (rebate_record_id)
        REFERENCES rebate_records (id) ON DELETE RESTRICT,
    CONSTRAINT fk_rebate_settlements_cashflow_id FOREIGN KEY (cashflow_id)
        REFERENCES cashflow (id) ON DELETE SET NULL,
    CONSTRAINT uq_rebate_settlements_no UNIQUE (settlement_no),
    CONSTRAINT uq_rebate_settlements_flow UNIQUE (cashflow_id)
)
""",
    "cashflow": """
CREATE TABLE cashflow (
    id INTEGER NOT NULL,
    flow_no VARCHAR(32) NOT NULL,
    pool_id INTEGER NOT NULL,
    occurred_on DATE NOT NULL,
    nature VARCHAR(16) NOT NULL,
    category VARCHAR(32) DEFAULT 'OTHER' NOT NULL,
    direction VARCHAR(8) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    order_event_id INTEGER,
    transfer_id VARCHAR(64),
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_cashflow PRIMARY KEY (id),
    CONSTRAINT ck_cashflow_cashflow_nature_valid CHECK (nature IN {nature}),
    CONSTRAINT ck_cashflow_cashflow_direction_valid CHECK (direction IN {direction}),
    CONSTRAINT fk_cashflow_pool_id FOREIGN KEY (pool_id)
        REFERENCES pools (id) ON DELETE RESTRICT,
    CONSTRAINT fk_cashflow_order_event_id FOREIGN KEY (order_event_id)
        REFERENCES order_events (id) ON DELETE SET NULL,
    CONSTRAINT uq_cashflow_no UNIQUE (flow_no),
    CONSTRAINT uq_cashflow_event UNIQUE (order_event_id)
)
""",
}

_REFERENCER_TOKENS = (
    ("{deposit_status}", _DEPOSIT_STATUS),
    ("{row_statuses}", _ROW_STATUSES),
    ("{event_type}", _EVENT_TYPES),
    ("{portion}", _PORTIONS),
    ("{nature}", _NATURES),
    ("{direction}", _DIRECTIONS),
)

# 引用方表结构不变：旧列 = 新列，逐字复制
_REFERENCER_COLS: dict[str, str] = {
    "deposits": (
        "id, deposit_no, pool_id, counterparty_id, source_order_id, paid_amount, "
        "returned_amount, status, paid_on, expected_release_on, released_on, note, "
        "created_at, updated_at, created_by, updated_by"
    ),
    "import_rows": (
        "id, batch_id, row_no, raw, mapped_order_id, mapped_account_id, mapped_by, "
        "status, issue_note, created_at, updated_at"
    ),
    "order_events": (
        "id, event_no, order_id, event_type, amount, portion, occurred_on, pool_id, "
        "offset_event_id, delivery_mode, is_posted, posted_at, reason, note, "
        "created_at, updated_at, created_by, updated_by"
    ),
    "installment_schedules": (
        "id, installment_id, period_no, due_on, due_amount, received_amount, received_on, "
        "status, created_at, updated_at"
    ),
    "rebate_settlements": (
        "id, settlement_no, rebate_record_id, settled_on, gross_amount, platform_fee, "
        "net_amount, cashflow_id, note, created_at, updated_at, created_by, updated_by"
    ),
    "cashflow": (
        "id, flow_no, pool_id, occurred_on, nature, category, direction, amount, "
        "order_event_id, transfer_id, note, created_at, updated_at, created_by, updated_by"
    ),
}

_REFERENCER_INDEXES: dict[str, list[str]] = {
    "deposits": [],
    "import_rows": ["CREATE INDEX ix_import_rows_batch ON import_rows (batch_id, status)"],
    "order_events": [
        "CREATE INDEX ix_order_events_order ON order_events (order_id, event_type, occurred_on)"
    ],
    "installment_schedules": [
        "CREATE INDEX ix_schedules_due ON installment_schedules (installment_id, due_on, status)"
    ],
    "rebate_settlements": [],
    "cashflow": [
        "CREATE INDEX ix_cashflow_pool_date ON cashflow (pool_id, occurred_on)",
        "CREATE INDEX ix_cashflow_nature ON cashflow (nature)",
        "CREATE INDEX ix_cashflow_transfer ON cashflow (transfer_id)",
    ],
}

_TOKENS = (
    ("{order_status}", _ORDER_STATUS),
    ("{capital_type}", _CAPITAL_TYPE),
    ("{contract_types}", _CONTRACT_TYPES),
    ("{inst_status}", _INST_STATUS),
    ("{rebate_status}", _REBATE_STATUS),
    ("{status}", _POLICY_STATUS_V2),
)


def _ddl(table: str, *, drop_snapshot: bool = False, drop_fk: bool = False) -> str:
    text = _DDLS[table]
    for token, value in _TOKENS:
        text = text.replace(token, value)
    if drop_snapshot:
        lines = [
            line
            for line in text.splitlines()
            if not line.strip().startswith(("policy_version_id ", "policy_snapshot "))
        ]
        text = "\n".join(lines)
    if drop_fk:
        # 外键声明跨两行：
        #   CONSTRAINT fk_xxx FOREIGN KEY (col)
        #       REFERENCES policy_versions (id) ON DELETE SET NULL
        # 删第一行会留下悬空的第二行（且前一项多出尾逗号），必须成对删除。
        lines = text.splitlines()
        kept: list[str] = []
        skip_references = False
        for line in lines:
            if "policy_version_id FOREIGN KEY" in line:
                skip_references = True
                continue
            if skip_references:
                skip_references = False
                if "REFERENCES policy_versions (id)" in line:
                    continue
            kept.append(line)
        text = "\n".join(kept)
        # 删列/删外键后，被删项的前一行会留下悬空内容：
        #  - 末项无逗号 → 下一行直接接 CONSTRAINT
        #  - 末项有逗号 → 变成 "..., CONSTRAINT" 同一行
        text = text.replace(",\n)", "\n)").replace(",\n    CONSTRAINT", "\n    CONSTRAINT")
        # 若被删项是「列定义」（无逗号结尾），后一行的分隔逗号会丢失，补回来。
        # 只补列定义行：含 CONSTRAINT / REFERENCES / PRIMARY / UNIQUE / CHECK / FOREIGN 的行跳过。
        lines = text.splitlines()
        for idx, line in enumerate(lines[:-1]):
            stripped = line.rstrip()
            if not stripped or stripped.endswith(",") or stripped.endswith("("):
                continue
            upper = stripped.upper()
            if any(kw in upper for kw in ("CONSTRAINT", "REFERENCES", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN")):
                continue
            nxt = lines[idx + 1].strip()
            if nxt and not nxt.startswith(")"):
                lines[idx] = stripped + ","
        text = "\n".join(lines)
    return text


def _table_exists(table: str) -> bool:
    return (
        op.get_bind()
        .execute(
            sa.text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": table},
        )
        .first()
        is not None
    )


def _columns_of(table: str) -> set[str]:
    if not _table_exists(table):
        return set()
    rows = op.get_bind().execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return {row[1] for row in rows}


def _rebuild(table: str) -> None:
    """建新表 → 拷数据 → 删旧表 → 改名 → 重建索引。

    三个必须处理的 SQLite 行为：
    1) `ALTER TABLE ... RENAME TO` 会**级联改写**引用方外键，让它们指向 `__old`；
    2) alembic 的 DDL 非事务，中途失败会留下 `__old` 残骸，故每步先清一次；
    3) downgrade 可能已删列（表还在但没有 policy_version_id），
       此时不能按「有表」判断走拷贝分支，必须按**列是否存在**判断。
    """
    old_expr, new_expr = _COPY[table]
    old_cols = [c.strip() for c in old_expr.split(",")]
    new_cols = [c.strip() for c in new_expr.split(",")]
    # 只搬运「旧表当前真实拥有」的列 —— 幂等的关键
    actual = _columns_of(table)
    keep = [c for c in new_cols if c in actual]

    op.execute(f"DROP TABLE IF EXISTS {table}__old")
    op.execute("PRAGMA foreign_keys=OFF")
    if actual:
        op.execute(f"ALTER TABLE {table} RENAME TO {table}__old")
        op.execute(_ddl(table))
        op.execute(
            f"INSERT INTO {table} ({', '.join(keep)}) SELECT {', '.join(keep)} FROM {table}__old"
        )
        op.execute(f"DROP TABLE {table}__old")
    else:
        # 首次迁移或 downgrade 已删表 → 直接建空表，保证 up 可重复执行
        op.execute(_ddl(table))
    for statement in _INDEXES[table]:
        op.execute(statement)
    op.execute("PRAGMA foreign_keys=ON")


def _rebuild_referencer(table: str) -> None:
    """重建「引用方」表，把被 RENAME 级联改歪的外键指回原表。"""
    ddl = _REFERENCER_DDL[table]
    for token, value in _REFERENCER_TOKENS:
        ddl = ddl.replace(token, value)
    cols = _REFERENCER_COLS[table]
    op.execute(f"DROP TABLE IF EXISTS {table}__old")
    op.execute("PRAGMA foreign_keys=OFF")
    if _table_exists(table):
        op.execute(f"ALTER TABLE {table} RENAME TO {table}__old")
        op.execute(ddl)
        op.execute(
            f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {table}__old"
        )
        op.execute(f"DROP TABLE {table}__old")
    else:
        op.execute(ddl)
    for statement in _REFERENCER_INDEXES[table]:
        op.execute(statement)
    op.execute("PRAGMA foreign_keys=ON")


def upgrade() -> None:
    # 顺序要点：
    # 1) policy_definitions → policy_versions（后者外键指向前者）
    # 2) orders / installments / rebate_records（加快照列）
    # 3) 重建它们的引用方，修复被 RENAME 级联改歪的外键
    # 4) order_profit_allocations（同时引用 orders 与 policy_versions）
    _rebuild("policy_definitions")
    _rebuild("policy_versions")
    _rebuild("orders")
    _rebuild("installments")
    _rebuild("rebate_records")
    for referencer in (
        *_REFERENCERS["orders"],
        *_REFERENCERS["installments"],
        *_REFERENCERS["rebate_records"],
    ):
        _rebuild_referencer(referencer)
    _rebuild("order_profit_allocations")


def downgrade() -> None:
    # 先把四张业务表退回无快照结构（同时修回被 RENAME 级联改歪的外键），
    # 再删规则表。顺序不能反：删 policy_versions 会连带破坏引用它的表。
    for referencer in (
        *_REFERENCERS["orders"],
        *_REFERENCERS["installments"],
        *_REFERENCERS["rebate_records"],
    ):
        _rebuild_referencer(referencer)
    for table in (
        "order_profit_allocations",
        "rebate_records",
        "installments",
        "orders",
    ):
        old_expr, new_expr = _COPY[table]
        new_cols = {c.strip() for c in new_expr.split(",")}
        keep = [
            c.strip()
            for c in old_expr.split(",")
            if c.strip() in new_cols and c.strip() != "policy_version_id"
        ]
        op.execute(f"DROP TABLE IF EXISTS {table}__old")
        op.execute("PRAGMA foreign_keys=OFF")
        if not _table_exists(table):
            continue
        op.execute(f"ALTER TABLE {table} RENAME TO {table}__old")
        op.execute(_ddl(table, drop_snapshot=True, drop_fk=True))
        op.execute(
            f"INSERT INTO {table} ({', '.join(keep)}) SELECT {', '.join(keep)} FROM {table}__old"
        )
        op.execute(f"DROP TABLE {table}__old")
        for statement in _INDEXES[table]:
            op.execute(statement)
        op.execute("PRAGMA foreign_keys=ON")
    # policy_definitions / policy_versions 归 0002 所有，**不能在这里删**
    # （0002 的 downgrade 会 drop 它们；这里删了 0002 就会报 no such table）。
    # 正确做法是回退成 0004 之前的 V1 形态，由 0002 负责最终删除。
    _rebuild_with_status_v1("policy_definitions")
    _rebuild_with_status_v1("policy_versions")


def _rebuild_with_status_v1(table: str) -> None:
    """把规则表回退成 V1 形态（status CHECK 不含 SUPERSEDED）。"""
    ddl = _DDLS[table]
    for token, value in _TOKENS:
        ddl = ddl.replace(token, value)
    ddl = ddl.replace(_POLICY_STATUS_V2, _POLICY_STATUS_V1)
    old_expr, _new_expr = _COPY[table]
    cols = ", ".join(c.strip() for c in old_expr.split(","))

    op.execute(f"DROP TABLE IF EXISTS {table}__old")
    op.execute("PRAGMA foreign_keys=OFF")
    if _table_exists(table):
        op.execute(f"ALTER TABLE {table} RENAME TO {table}__old")
        op.execute(ddl)
        op.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {table}__old")
        op.execute(f"DROP TABLE {table}__old")
    else:
        op.execute(ddl)
    op.execute("PRAGMA foreign_keys=ON")
