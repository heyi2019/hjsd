"""MIG-01 补齐：补录依据、UNLINKED_TRANSFER 标记、回滚与更正批次。

对应验收项：
- MIG-01-05 历史关系补录需记录「补录人/时间/依据」，并保留映射前后状态
- MIG-01-06 未裁决的历史单边划转显式标 UNLINKED_TRANSFER（仅标记，不生成配对流水）
- MIG-01-07 未确认批次可整批逻辑回滚；已确认批次走冲销/更正
- MIG-01-08 原始字段不可直接改，更正走独立批次分层保存

SQLite 注意：不支持 ALTER TABLE ADD CONSTRAINT，改 CHECK 约束必须走
「建新表 → 拷数据 → 删旧表 → 改名」十二步（batch_alter_table 的 recreate 亦可，
但自建表更可控，且能同时加自引用外键）。

revision: 0004_m4_history_closure
down_revision: 0003_m4_quality
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004_m4_history_closure"
down_revision = "0003_m4_quality"

BATCH_STATUSES = (
    "('DRAFT', 'MAPPED', 'COMMITTED', 'REJECTED', 'ROLLED_BACK', 'CORRECTED')"
)
ROW_STATUSES = "('PENDING', 'MAPPED', 'UNMAPPED', 'IMPORTED', 'SKIPPED', 'ROLLED_BACK')"
# 回滚到 0003 时的旧枚举集合（同样必须带外层括号，SQLite 不接受裸列表）
ROW_STATUSES_V1 = "('PENDING', 'MAPPED', 'UNMAPPED', 'IMPORTED', 'SKIPPED')"
BATCH_STATUSES_V1 = "('DRAFT', 'MAPPED', 'COMMITTED', 'REJECTED')"

# 新表 DDL：列顺序与 app/domain/quality.py 的模型保持一致
_BATCH_COLS = """
    id INTEGER NOT NULL,
    batch_no VARCHAR(32) NOT NULL,
    source_name VARCHAR(128) NOT NULL,
    source_kind VARCHAR(32) DEFAULT 'LEGACY_ORDER' NOT NULL,
    status VARCHAR(16) DEFAULT 'DRAFT' NOT NULL,
    row_count INTEGER DEFAULT '0' NOT NULL,
    unmapped_count INTEGER DEFAULT '0' NOT NULL,
    committed_at DATETIME,
    rolled_back_at DATETIME,
    rolled_back_by VARCHAR(64),
    rollback_reason TEXT,
    corrects_batch_id INTEGER,
    note TEXT,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_import_batches PRIMARY KEY (id),
    CONSTRAINT ck_import_batches_status CHECK (status IN {batch_statuses}),
    CONSTRAINT uq_import_batches_batch_no UNIQUE (batch_no),
    CONSTRAINT fk_import_batches_corrects FOREIGN KEY (corrects_batch_id)
        REFERENCES import_batches (id) ON DELETE SET NULL
"""

_ROW_COLS = """
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
    CONSTRAINT ck_import_rows_status CHECK (status IN {row_statuses}),
    CONSTRAINT fk_import_rows_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON DELETE CASCADE,
    CONSTRAINT fk_import_rows_order FOREIGN KEY (mapped_order_id)
        REFERENCES orders (id) ON DELETE SET NULL,
    CONSTRAINT fk_import_rows_account FOREIGN KEY (mapped_account_id)
        REFERENCES accounts (id) ON DELETE SET NULL
"""

# 旧表已存在的列（0003 建表时的列）与新增列分开维护。
# 新增列在拷贝时不取，交给表默认值 —— 避免手工维护两串等长列清单导致列数错位。
# quality_issues 的 CHECK 约束在 0003 里被固化了，新增 IssueType 必须重建表。
# 漏了这步 → 插入 UNLINKED_TRANSFER 工单时 sqlite3.IntegrityError（实测踩过）。
_ISSUE_TYPES_V1 = (
    "('UNROUTED_EVENT', 'SINGLE_SIDED_TRANSFER', 'NEGATIVE_AVAILABLE', 'TH_UNCLOSED', "
    "'UNCOLLECTED_REBATE', 'OVERDUE_INSTALLMENT', 'ACCOUNT_CONFLICT', "
    "'ORPHAN_CASHFLOW', 'HISTORY_UNMAPPED')"
)
_ISSUE_TYPES_V2 = (
    "('UNROUTED_EVENT', 'SINGLE_SIDED_TRANSFER', 'NEGATIVE_AVAILABLE', 'TH_UNCLOSED', "
    "'UNCOLLECTED_REBATE', 'OVERDUE_INSTALLMENT', 'ACCOUNT_CONFLICT', "
    "'ORPHAN_CASHFLOW', 'HISTORY_UNMAPPED', 'UNLINKED_TRANSFER')"
)
_ISSUE_SEVERITIES = "('BLOCKER', 'HIGH', 'MEDIUM', 'LOW')"
_ISSUE_STATUSES = "('OPEN', 'ASSIGNED', 'RESOLVED', 'CLOSED', 'IGNORED')"

_ISSUE_COLS = """
    id INTEGER NOT NULL,
    issue_no VARCHAR(32) NOT NULL,
    issue_type VARCHAR(32) NOT NULL,
    severity VARCHAR(16) DEFAULT 'MEDIUM' NOT NULL,
    status VARCHAR(16) DEFAULT 'OPEN' NOT NULL,
    entity_type VARCHAR(32) NOT NULL,
    entity_id INTEGER,
    entity_label VARCHAR(64),
    amount NUMERIC(18, 2) DEFAULT '0' NOT NULL,
    detected_on DATE NOT NULL,
    owner_id INTEGER,
    resolution TEXT,
    closed_at DATETIME,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    updated_by VARCHAR(64) DEFAULT 'system' NOT NULL,
    CONSTRAINT pk_quality_issues PRIMARY KEY (id),
    CONSTRAINT ck_quality_issues_issue_type_valid CHECK (issue_type IN {issue_types}),
    CONSTRAINT ck_quality_issues_issue_severity_valid CHECK (severity IN {severities}),
    CONSTRAINT ck_quality_issues_issue_status_valid CHECK (status IN {statuses}),
    CONSTRAINT uq_quality_issues_issue_no UNIQUE (issue_no)
"""

_ISSUE_COLS_ALL = (
    "id, issue_no, issue_type, severity, status, entity_type, entity_id, entity_label, "
    "amount, detected_on, owner_id, resolution, closed_at, note, "
    "created_at, updated_at, created_by, updated_by"
)
_ISSUE_INDEXES = [
    "CREATE INDEX ix_quality_issues_type_status ON quality_issues (issue_type, status)",
    "CREATE INDEX ix_quality_issues_detected ON quality_issues (detected_on)",
]

_BATCH_OLD_COLS = (
    "id, batch_no, source_name, source_kind, status, row_count, unmapped_count, "
    "committed_at, note, created_by, updated_by, created_at, updated_at"
)
_BATCH_NEW_COLS = (
    "id, batch_no, source_name, source_kind, status, row_count, unmapped_count, "
    "committed_at, rolled_back_at, rolled_back_by, rollback_reason, corrects_batch_id, "
    "note, created_by, updated_by, created_at, updated_at"
)
_ROW_OLD_COLS = (
    "id, batch_id, row_no, raw, mapped_order_id, mapped_account_id, mapped_by, "
    "status, issue_note, created_at, updated_at"
)
_ROW_NEW_COLS = (
    "id, batch_id, row_no, raw, mapped_order_id, mapped_account_id, mapped_by, mapped_at, "
    "mapping_basis, mapped_before, status, unlinked_transfer, issue_note, created_at, updated_at"
)


def _copy_exprs(old_cols: str, new_cols: str) -> tuple[str, str]:
    """生成 INSERT 列清单与 SELECT 源列清单。

    两侧必须等长：只搬运「当前表已有」的列，新增列交给表默认值。
    old_cols = 迁移前表已存在的列；new_cols = 迁移后表定义的列。
    """
    old = [c.strip() for c in old_cols.split(",") if c.strip()]
    new = [c.strip() for c in new_cols.split(",") if c.strip()]
    keep = [c for c in new if c in old]
    missing = [c for c in old if c not in new]
    if missing:
        raise RuntimeError(f"迁移列清单不匹配，旧表列未出现在新表定义中：{missing}")
    assert len(keep) == len(old), "INSERT/SELECT 列数必须一致"
    return ", ".join(keep), ", ".join(keep)


def _rebuild(
    table: str,
    cols: str,
    old_cols: str,
    new_cols: str,
    indexes: list[str],
) -> None:
    """建新表 → 拷数据 → 删旧表 → 改名 → 重建索引。"""
    insert_cols, select_exprs = _copy_exprs(old_cols, new_cols)
    op.execute(f"ALTER TABLE {table} RENAME TO {table}_old")
    op.execute(f"CREATE TABLE {table} ({cols})")
    op.execute(
        f"INSERT INTO {table} ({insert_cols}) SELECT {select_exprs} FROM {table}_old"  # noqa: S608
    )
    op.execute(f"DROP TABLE {table}_old")
    for ddl in indexes:
        op.execute(ddl)


def upgrade() -> None:
    _rebuild(
        "quality_issues",
        _ISSUE_COLS.format(
            issue_types=_ISSUE_TYPES_V2,
            severities=_ISSUE_SEVERITIES,
            statuses=_ISSUE_STATUSES,
        ),
        _ISSUE_COLS_ALL,
        _ISSUE_COLS_ALL,
        list(_ISSUE_INDEXES),
    )
    _rebuild(
        "import_batches",
        _BATCH_COLS.replace('{batch_statuses}', BATCH_STATUSES),
        _BATCH_OLD_COLS,
        _BATCH_NEW_COLS,
        [],
    )
    _rebuild(
        "import_rows",
        _ROW_COLS.replace('{row_statuses}', ROW_STATUSES),
        _ROW_OLD_COLS,
        _ROW_NEW_COLS,
        ["CREATE INDEX ix_import_rows_batch ON import_rows (batch_id, status)"],
    )


def downgrade() -> None:
    _rebuild(
        "quality_issues",
        _ISSUE_COLS.format(
            issue_types=_ISSUE_TYPES_V1,
            severities=_ISSUE_SEVERITIES,
            statuses=_ISSUE_STATUSES,
        ),
        _ISSUE_COLS_ALL,
        _ISSUE_COLS_ALL,
        list(_ISSUE_INDEXES),
    )
    _rebuild(
        "import_rows",
        _ROW_COLS.replace('{row_statuses}', ROW_STATUSES_V1),
        _ROW_OLD_COLS,
        _ROW_NEW_COLS,
        ["CREATE INDEX ix_import_rows_batch ON import_rows (batch_id, status)"],
    )
    _rebuild(
        "import_batches",
        _BATCH_COLS.replace('{batch_statuses}', BATCH_STATUSES_V1),
        _BATCH_OLD_COLS,
        _BATCH_NEW_COLS,
        [],
    )
