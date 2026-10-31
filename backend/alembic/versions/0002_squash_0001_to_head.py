"""压平迁移：0001 基线 -> 最终态（合并原 0002..0071 全部 DDL 增量与种子数据）。

由 build_squash.py 程序化提取并拼接生成，经「完整链 vs 仅 0001+本文件」逐表对拍验证一致。
down_revision = 0001（基线）；本文件为唯一 head。原 0002..0071 已删除。
"""

from __future__ import annotations
import json
import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.trade import OrderFormField
from sqlalchemy.sql.naming import conv


revision = "0002_squash"
down_revision = "0001"
branch_labels = None
depends_on = None


m2_revision = '0002'
m2_down_revision = '0001'
m2_branch_labels = None
m2_depends_on = None
m2__VAS_OPTIONS = json.dumps([{'value': 'STOCK_SALE', 'label': '分期'}, {'value': 'ADVANCE_PURCHASE', 'label': '代分期'}], ensure_ascii=False)
m2__SEQ_KEYS_COMMON = [('CUSTOMER', '客户'), ('COUNTERPARTY', '合作方'), ('LEAD', '需求'), ('QUALITY_ISSUE', '质量工单'), ('NOTIFICATION', '通知'), ('CASHFLOW', '资金流水'), ('IMPORT', '导入批次'), ('ATTACHMENT', '附件')]
m2__SEQ_OPTIONS_NEW = json.dumps([{'value': 'ORDER_HS', 'label': '回收编号'}, {'value': 'ORDER_TH', 'label': '提号编号'}, {'value': 'ORDER_DG', 'label': '代挂编号'}, {'value': 'ORDER_DFQ', 'label': '代分期编号'}, {'value': 'INSTALLMENT', 'label': '分期编号'}, *[{'value': value, 'label': label} for value, label in m2__SEQ_KEYS_COMMON]], ensure_ascii=False)
m2__SEQ_OPTIONS_OLD = json.dumps([{'value': 'ORDER_HS', 'label': '回收订单'}, {'value': 'ORDER_TH', 'label': '提号订单'}, {'value': 'ORDER_DG', 'label': '代挂订单'}, {'value': 'ORDER_DFQ', 'label': '代分期订单'}, *[{'value': value, 'label': label} for value, label in m2__SEQ_KEYS_COMMON]], ensure_ascii=False)
m2__BACKFILL_ACCOUNTS = "\nINSERT INTO accounts (\n    game_type, business_mode, inventory_type, value_added_service, game_account,\n    game_password, channel_region, bound_phone, has_secondary, platform, status,\n    cost_amount, note, created_by, updated_by\n)\nSELECT\n    json_extract(o.account_snapshot, '$.game_type'),\n    'DISTRIBUTION',\n    NULL,\n    'ADVANCE_PURCHASE',\n    json_extract(o.account_snapshot, '$.game_account'),\n    json_extract(o.account_snapshot, '$.game_password'),\n    json_extract(o.account_snapshot, '$.channel_region'),\n    json_extract(o.account_snapshot, '$.bound_phone'),\n    json_extract(o.account_snapshot, '$.has_secondary'),\n    json_extract(o.account_snapshot, '$.platform'),\n    'IN_STOCK',\n    0,\n    '代分期垫资账号入库回填（迁移 0002，来源订单 ' || o.order_no || '）',\n    'migration',\n    'migration'\nFROM orders o\nWHERE o.order_type = 'DFQ'\n  AND o.account_id IS NULL\n  AND o.account_snapshot IS NOT NULL\n  AND json_extract(o.account_snapshot, '$.game_account') IS NOT NULL\n  AND json_extract(o.account_snapshot, '$.game_account') != ''\n  AND NOT EXISTS (\n      SELECT 1 FROM accounts a\n      WHERE a.game_account = json_extract(o.account_snapshot, '$.game_account')\n  )\n"
m2__BACKFILL_ORDER_LINK = "\nUPDATE orders\nSET account_id = (\n    SELECT a.id FROM accounts a\n    WHERE a.game_account = json_extract(orders.account_snapshot, '$.game_account')\n      AND a.value_added_service = 'ADVANCE_PURCHASE'\n      AND a.created_by = 'migration'\n)\nWHERE order_type = 'DFQ'\n  AND account_id IS NULL\n  AND account_snapshot IS NOT NULL\n  AND json_extract(account_snapshot, '$.game_account') IS NOT NULL\n  AND EXISTS (\n      SELECT 1 FROM accounts a\n      WHERE a.game_account = json_extract(orders.account_snapshot, '$.game_account')\n        AND a.value_added_service = 'ADVANCE_PURCHASE'\n        AND a.created_by = 'migration'\n  )\n"
def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DELETE FROM option_sets WHERE code = 'VALUE_ADDED_SERVICE'"))
    bind.execute(text("UPDATE option_sets SET label = '库存类型' WHERE code = 'INVENTORY_TYPE'"))
    bind.execute(text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"), {'options': m2__SEQ_OPTIONS_OLD})
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key = 'INSTALLMENT'"))
    op.drop_column('accounts', 'value_added_service')
m3_revision = '0003'
m3_down_revision = '0002'
m3_branch_labels = None
m3_depends_on = None
m3__DDL_TEMPLATE = 'CREATE TABLE {name} (\n\tid INTEGER NOT NULL, \n\tsequence_key VARCHAR(64) NOT NULL, \n\tprefix VARCHAR(16) NOT NULL, \n\tpadding INTEGER NOT NULL, \n\tcurrent_value INTEGER NOT NULL, \n\tcreated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, \n\tupdated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, \n\tCONSTRAINT pk_document_sequences PRIMARY KEY (id), \n\tCONSTRAINT uq_document_sequences_key UNIQUE (sequence_key), \n\tCONSTRAINT ck_document_sequences_padding_positive CHECK (padding > 0), \n\tCONSTRAINT ck_document_sequences_current_value_nonneg CHECK (current_value >= 0), \n\tCONSTRAINT ck_document_sequences_padding_max CHECK (padding <= {padding_max}), \n\tCONSTRAINT ck_document_sequences_current_value_max CHECK (current_value <= {value_max}), \n\tCONSTRAINT ck_document_sequences_sequence_key_nonempty CHECK (length(trim(sequence_key)) > 0), \n\tCONSTRAINT ck_document_sequences_prefix_nonempty CHECK (length(trim(prefix)) > 0)\n)'
m3__SEQ_OPTIONS_NEW = json.dumps([{'value': 'ORDER_HS', 'label': '回收编号'}, {'value': 'ORDER_TH', 'label': '提号编号'}, {'value': 'ORDER_DG', 'label': '代挂编号'}, {'value': 'ORDER_DFQ', 'label': '代分期订单'}, {'value': 'INSTALLMENT', 'label': '分期订单'}, {'value': 'CASHFLOW_OUT', 'label': '支出流水'}, {'value': 'CASHFLOW_IN', 'label': '收入流水'}, {'value': 'CUSTOMER', 'label': '客户'}, {'value': 'COUNTERPARTY', 'label': '合作方'}, {'value': 'LEAD', 'label': '需求'}, {'value': 'QUALITY_ISSUE', 'label': '质量工单'}, {'value': 'NOTIFICATION', 'label': '通知'}, {'value': 'IMPORT', 'label': '导入批次'}, {'value': 'ATTACHMENT', 'label': '附件'}], ensure_ascii=False)
m3__SEQ_OPTIONS_OLD = json.dumps([{'value': 'ORDER_HS', 'label': '回收编号'}, {'value': 'ORDER_TH', 'label': '提号编号'}, {'value': 'ORDER_DG', 'label': '代挂编号'}, {'value': 'ORDER_DFQ', 'label': '代分期编号'}, {'value': 'INSTALLMENT', 'label': '分期编号'}, {'value': 'CASHFLOW', 'label': '资金流水'}, {'value': 'CUSTOMER', 'label': '客户'}, {'value': 'COUNTERPARTY', 'label': '合作方'}, {'value': 'LEAD', 'label': '需求'}, {'value': 'QUALITY_ISSUE', 'label': '质量工单'}, {'value': 'NOTIFICATION', 'label': '通知'}, {'value': 'IMPORT', 'label': '导入批次'}, {'value': 'ATTACHMENT', 'label': '附件'}], ensure_ascii=False)
def m3__rebuild_table(padding_max: int, value_max: int) -> None:
    """按「建新表→拷→删→改名」重建 document_sequences（SQLite 不支持改 CHECK）。"""
    bind = op.get_bind()
    bind.execute(text(m3__DDL_TEMPLATE.format(name='document_sequences_new', padding_max=padding_max, value_max=value_max)))
    bind.execute(text('INSERT INTO document_sequences_new (id, sequence_key, prefix, padding, current_value, created_at, updated_at) SELECT id, sequence_key, prefix, padding, current_value, created_at, updated_at FROM document_sequences'))
    bind.execute(text('DROP TABLE document_sequences'))
    bind.execute(text('ALTER TABLE document_sequences_new RENAME TO document_sequences'))
def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key IN ('CASHFLOW_OUT', 'CASHFLOW_IN')"))
    bind.execute(text("INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) VALUES ('CASHFLOW', 'CF', 4, 0)"))
    bind.execute(text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"), {'options': m3__SEQ_OPTIONS_OLD})
    m3__rebuild_table(padding_max=4, value_max=9999)
m4_revision = '0004'
m4_down_revision = '0003'
m4_branch_labels = None
m4_depends_on = None
def downgrade() -> None:
    bind = op.get_bind()
    op.drop_index('uq_accounts_stock_no', table_name='accounts')
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key = 'STOCK_NO'"))
    op.drop_column('accounts', 'stock_no')
m5_revision = '0005'
m5_down_revision = '0004'
m5_branch_labels = None
m5_depends_on = None
m5__SRC_OPTIONS = '[{"value": "自营", "label": "自营"}, {"value": "微博", "label": "微博"}, {"value": "小红书", "label": "小红书"}, {"value": "闲鱼", "label": "闲鱼"}, {"value": "同行推荐", "label": "同行推荐"}, {"value": "其他", "label": "其他"}]'
def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("UPDATE order_form_fields SET required = 0, field_type = 'SELECT', options = :opts WHERE field_key = 'customer_source'"), {'opts': m5__SRC_OPTIONS})
    bind.execute(text("UPDATE order_form_fields SET required = 1, field_type = 'SELECT', options = :opts WHERE field_key = 'dg_customer_source'"), {'opts': m5__SRC_OPTIONS})
    bind.execute(text("UPDATE order_form_fields SET required = 1, field_type = 'SELECT', options = :opts WHERE field_key = 'dfq_customer_source'"), {'opts': m5__SRC_OPTIONS})
    bind.execute(text('INSERT INTO order_form_fields (id, order_type_code, field_key, label, field_type, options, required, is_active,  sort_order, locked, is_custom, note, created_by, updated_by, created_at, updated_at,  required_when) VALUES (10, \'HS\', \'customer_source_other\', \'其他来源\', \'TEXT\', NULL, 0, 1, 130, 0, 0,  NULL, \'system\', \'system\', \'2026-10-25 08:53:39\', \'2026-10-25 08:53:39\',  \'{"field": "customer_source", "op": "eq", "values": ["其他"]}\')'))
    bind.execute(text('INSERT INTO order_form_fields (id, order_type_code, field_key, label, field_type, options, required, is_active,  sort_order, locked, is_custom, note, created_by, updated_by, created_at, updated_at,  required_when) VALUES (65, \'DG\', \'dg_customer_source_other\', \'其他来源\', \'TEXT\', NULL, 0, 1, 130, 0, 0,  NULL, \'system\', \'system\', \'2026-10-25 08:53:39\', \'2026-10-25 08:53:39\',  \'{"field": "dg_customer_source", "op": "eq", "values": ["其他"]}\')'))
m6_revision = '0006'
m6_down_revision = '0005'
m6_branch_labels = None
m6_depends_on = None
m6__RENUMBER_TO_KU5 = "UPDATE accounts SET stock_no = 'KU_' || printf('%05d', (SELECT COUNT(*) FROM accounts AS prev WHERE prev.id <= accounts.id))"
m6__RENUMBER_TO_KU4 = "UPDATE accounts SET stock_no = 'KU' || printf('%04d', (SELECT COUNT(*) FROM accounts AS prev WHERE prev.id <= accounts.id))"
def m6__renumber(sql: str) -> None:
    """按 id 升序整表重刷 stock_no（同语句内自关联计数，天然逐行唯一）。"""
    op.execute(text(sql))
def downgrade() -> None:
    m6__renumber(m6__RENUMBER_TO_KU4)
    op.execute(text("UPDATE document_sequences SET prefix = 'KU', padding = 4, updated_at = CURRENT_TIMESTAMP WHERE sequence_key = 'STOCK_NO'"))
m7_revision = '0007'
m7_down_revision = '0006'
m7_branch_labels = None
m7_depends_on = None
m7__ORDERS_COLUMNS = 'id, order_no, order_type, capital_type, trade_date, account_id, status, policy_version_id, policy_snapshot, link_status, owner_id, note, created_by, updated_by, created_at, updated_at, commission_mode, commission_payer, account_snapshot, game_type, game_account, game_password, channel_region, bound_phone, has_secondary, account_note, form_extra'
m7__ORDERS_INDEXES = (('ix_orders_owner_id', 'CREATE INDEX ix_orders_owner_id ON orders (owner_id)'), ('ix_orders_trade_date', 'CREATE INDEX ix_orders_trade_date ON orders (trade_date)'), ('ix_orders_link_status', 'CREATE INDEX ix_orders_link_status ON orders (link_status)'), ('ix_orders_policy_version_id', 'CREATE INDEX ix_orders_policy_version_id ON orders (policy_version_id)'), ('ix_orders_account_id', 'CREATE INDEX ix_orders_account_id ON orders (account_id)'), ('ix_orders_type_date', 'CREATE INDEX ix_orders_type_date ON orders (order_type, trade_date)'))
m7__ORDERS_TABLE_TMPL = "CREATE TABLE {token} (\n    id INTEGER NOT NULL,\n    order_no VARCHAR(32) NOT NULL,\n    order_type VARCHAR(16) NOT NULL,\n    capital_type VARCHAR(16) NOT NULL,\n    trade_date DATE NOT NULL,\n    account_id INTEGER,\n    status VARCHAR(16) NOT NULL,\n    policy_version_id INTEGER,\n    policy_snapshot JSON,\n    link_status VARCHAR(24) NOT NULL,\n    owner_id INTEGER,\n    note TEXT,\n    created_by VARCHAR(64) NOT NULL,\n    updated_by VARCHAR(64) NOT NULL,\n    created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,\n    updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,\n    commission_mode VARCHAR(32),\n    commission_payer VARCHAR(16),\n    account_snapshot JSON,\n    game_type VARCHAR(64),\n    game_account VARCHAR(128),\n    game_password VARCHAR(256),\n    channel_region VARCHAR(128),\n    bound_phone VARCHAR(64),\n    has_secondary BOOLEAN,\n    account_note TEXT,\n    form_extra JSON,\n    CONSTRAINT pk_orders PRIMARY KEY (id),\n    CONSTRAINT uq_orders_no UNIQUE (order_no),\n    CONSTRAINT fk_orders_account_id FOREIGN KEY(account_id) REFERENCES accounts (id) ON DELETE SET NULL,\n    CONSTRAINT fk_orders_owner_id FOREIGN KEY(owner_id) REFERENCES users (id) ON DELETE SET NULL,\n    CONSTRAINT fk_orders_policy_version_id FOREIGN KEY(policy_version_id) REFERENCES policy_versions (id) ON DELETE SET NULL,\n    CONSTRAINT ck_orders_order_status_valid CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),\n    CONSTRAINT ck_orders_order_capital_type_valid CHECK (capital_type IN ('STOCK', 'ZERO', 'CREDIT')),\n    CONSTRAINT ck_orders_order_link_status_valid CHECK (link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')),\n    CONSTRAINT ck_orders_order_commission_mode_valid CHECK (commission_mode IS NULL OR commission_mode IN ('DEDUCT_FROM_SETTLEMENT', 'SEPARATE_PAYMENT')),\n    CONSTRAINT ck_orders_order_commission_payer_valid CHECK (commission_payer IS NULL OR commission_payer IN ('BUYER', 'CONSIGNOR', 'PLATFORM')),\n    CONSTRAINT ck_orders_order_commission_pair_valid CHECK ((commission_mode IS NULL) = (commission_payer IS NULL)),\n    CONSTRAINT ck_orders_order_commission_type_valid CHECK (order_type = 'DG' OR (commission_mode IS NULL AND commission_payer IS NULL)),\n    CONSTRAINT ck_orders_order_account_snapshot_type_valid CHECK ({snapshot_check})\n)"
m7__SNAPSHOT_CHECK_NEW = "account_snapshot IS NULL OR account_snapshot = 'null' OR order_type IN ('HS', 'TH', 'DG', 'DFQ')"
m7__SNAPSHOT_CHECK_OLD = "order_type = 'DFQ' OR account_snapshot IS NULL OR account_snapshot = 'null'"
def m7__rebuild(snapshot_check: str) -> None:
    op.execute(text(m7__ORDERS_TABLE_TMPL.format(token='_orders_new_0007', snapshot_check=snapshot_check)))
    op.execute(text(f'INSERT INTO _orders_new_0007 ({m7__ORDERS_COLUMNS}) SELECT {m7__ORDERS_COLUMNS} FROM orders'))
    op.execute(text('DROP TABLE orders'))
    op.execute(text('ALTER TABLE _orders_new_0007 RENAME TO orders'))
    for _, ddl in m7__ORDERS_INDEXES:
        op.execute(text(ddl))
def downgrade() -> None:
    m7__rebuild(m7__SNAPSHOT_CHECK_OLD)
m8_revision = '0008'
m8_down_revision = '0007'
m8_branch_labels = None
m8_depends_on = None
m8__REMOVED_COLUMNS = ('game_type', 'game_account', 'game_password', 'channel_region', 'bound_phone', 'has_secondary', 'account_note')
m8__FOLD_FLAT_INTO_SNAPSHOT = "\nUPDATE orders\nSET account_snapshot = json_object(\n    'game_account', game_account,\n    'game_type', game_type,\n    'game_password', game_password,\n    'channel_region', channel_region,\n    'bound_phone', bound_phone,\n    'has_secondary', has_secondary,\n    'note', account_note)\nWHERE (account_snapshot IS NULL OR account_snapshot = 'null')\n  AND game_account IS NOT NULL\n"
m8__ORDERS_COLUMNS = 'id, order_no, order_type, capital_type, trade_date, account_id, status, policy_version_id, policy_snapshot, link_status, owner_id, note, created_by, updated_by, created_at, updated_at, commission_mode, commission_payer, account_snapshot, form_extra'
m8__ORDERS_INDEXES = (('ix_orders_owner_id', 'CREATE INDEX ix_orders_owner_id ON orders (owner_id)'), ('ix_orders_trade_date', 'CREATE INDEX ix_orders_trade_date ON orders (trade_date)'), ('ix_orders_link_status', 'CREATE INDEX ix_orders_link_status ON orders (link_status)'), ('ix_orders_policy_version_id', 'CREATE INDEX ix_orders_policy_version_id ON orders (policy_version_id)'), ('ix_orders_account_id', 'CREATE INDEX ix_orders_account_id ON orders (account_id)'), ('ix_orders_type_date', 'CREATE INDEX ix_orders_type_date ON orders (order_type, trade_date)'))
m8__ORDERS_TABLE_TMPL = "CREATE TABLE {token} (\n    id INTEGER NOT NULL,\n    order_no VARCHAR(32) NOT NULL,\n    order_type VARCHAR(16) NOT NULL,\n    capital_type VARCHAR(16) NOT NULL,\n    trade_date DATE NOT NULL,\n    account_id INTEGER,\n    status VARCHAR(16) NOT NULL,\n    policy_version_id INTEGER,\n    policy_snapshot JSON,\n    link_status VARCHAR(24) NOT NULL,\n    owner_id INTEGER,\n    note TEXT,\n    created_by VARCHAR(64) NOT NULL,\n    updated_by VARCHAR(64) NOT NULL,\n    created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,\n    updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,\n    commission_mode VARCHAR(32),\n    commission_payer VARCHAR(16),\n    account_snapshot JSON,\n    form_extra JSON,\n    CONSTRAINT pk_orders PRIMARY KEY (id),\n    CONSTRAINT uq_orders_no UNIQUE (order_no),\n    CONSTRAINT fk_orders_account_id FOREIGN KEY(account_id) REFERENCES accounts (id) ON DELETE SET NULL,\n    CONSTRAINT fk_orders_owner_id FOREIGN KEY(owner_id) REFERENCES users (id) ON DELETE SET NULL,\n    CONSTRAINT fk_orders_policy_version_id FOREIGN KEY(policy_version_id) REFERENCES policy_versions (id) ON DELETE SET NULL,\n    CONSTRAINT ck_orders_order_status_valid CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),\n    CONSTRAINT ck_orders_order_capital_type_valid CHECK (capital_type IN ('STOCK', 'ZERO', 'CREDIT')),\n    CONSTRAINT ck_orders_order_link_status_valid CHECK (link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')),\n    CONSTRAINT ck_orders_order_commission_mode_valid CHECK (commission_mode IS NULL OR commission_mode IN ('DEDUCT_FROM_SETTLEMENT', 'SEPARATE_PAYMENT')),\n    CONSTRAINT ck_orders_order_commission_payer_valid CHECK (commission_payer IS NULL OR commission_payer IN ('BUYER', 'CONSIGNOR', 'PLATFORM')),\n    CONSTRAINT ck_orders_order_commission_pair_valid CHECK ((commission_mode IS NULL) = (commission_payer IS NULL)),\n    CONSTRAINT ck_orders_order_commission_type_valid CHECK (order_type = 'DG' OR (commission_mode IS NULL AND commission_payer IS NULL)),\n    CONSTRAINT ck_orders_order_account_snapshot_type_valid CHECK (account_snapshot IS NULL OR account_snapshot = 'null' OR order_type IN ('HS', 'TH', 'DG', 'DFQ'))\n)"
def m8__rebuild_without_flat_columns() -> None:
    op.execute(text(m8__ORDERS_TABLE_TMPL.format(token='_orders_new_0008')))
    op.execute(text(f'INSERT INTO _orders_new_0008 ({m8__ORDERS_COLUMNS}) SELECT {m8__ORDERS_COLUMNS} FROM orders'))
    op.execute(text('DROP TABLE orders'))
    op.execute(text('ALTER TABLE _orders_new_0008 RENAME TO orders'))
    for _, ddl in m8__ORDERS_INDEXES:
        op.execute(text(ddl))
def downgrade() -> None:
    op.execute(text(m8__ORDERS_TABLE_TMPL.replace('{token}', '_orders_old_0008').replace('    form_extra JSON,\n', '    form_extra JSON,\n    game_type VARCHAR(64),\n    game_account VARCHAR(128),\n    game_password VARCHAR(256),\n    channel_region VARCHAR(128),\n    bound_phone VARCHAR(64),\n    has_secondary BOOLEAN,\n    account_note TEXT,\n')))
    op.execute(text(f'INSERT INTO _orders_old_0008 ({m8__ORDERS_COLUMNS}) SELECT {m8__ORDERS_COLUMNS} FROM orders'))
    op.execute(text('DROP TABLE orders'))
    op.execute(text('ALTER TABLE _orders_old_0008 RENAME TO orders'))
    for _, ddl in m8__ORDERS_INDEXES:
        op.execute(text(ddl))
m9_revision = '0009'
m9_down_revision = '0008'
m9_branch_labels = None
m9_depends_on = None
def m9__index_names() -> list[str]:
    bind = op.get_bind()
    rows = bind.execute(text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stocks' AND name LIKE 'ix\\_accounts\\_%' ESCAPE '\\'")).fetchall()
    return [r[0] for r in rows]
def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stocks' AND name LIKE 'ix\\_stocks\\_%' ESCAPE '\\'")).fetchall()
    op.execute(text('ALTER TABLE stocks RENAME TO accounts'))
    for old_name, in rows:
        suffix = old_name.removeprefix('ix_stocks_')
        op.execute(text(f'DROP INDEX {old_name}'))
        op.execute(text(f'CREATE INDEX ix_accounts_{suffix} ON accounts ({suffix})'))
m10_revision = '0010'
m10_down_revision = '0009'
m10_branch_labels = None
m10_depends_on = None
m10__STOCKS_DDL = "CREATE TABLE {token} (\n\tid INTEGER NOT NULL,\n\tgame_type VARCHAR(64),\n\tbusiness_mode VARCHAR(24),\n\tinventory_type VARCHAR(24),\n\tgame_account VARCHAR(128),\n\tgame_password VARCHAR(256),\n\tchannel_region VARCHAR(128),\n\tbound_phone VARCHAR(64),\n\thas_secondary BOOLEAN,\n\tplatform VARCHAR(64),\n\tstatus VARCHAR(16) NOT NULL,\n\tbuy_date DATE,\n\tcost_amount NUMERIC(18, 2) NOT NULL,\n\tnote TEXT,\n\tcreated_by VARCHAR(64) NOT NULL,\n\tupdated_by VARCHAR(64) NOT NULL,\n\tcreated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,\n\tupdated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,\n\taccount_description TEXT,\n\taccount_images JSON, form_extra JSON, value_added_service VARCHAR(32), stock_no VARCHAR(32),\n\tCONSTRAINT pk_accounts PRIMARY KEY (id),\n\tCONSTRAINT ck_accounts_account_inventory_type_valid CHECK (inventory_type IS NULL OR inventory_type IN ('RECOVERY', 'PICKUP', 'CONSIGNMENT')),\n\tCONSTRAINT ck_accounts_account_business_mode_valid CHECK (business_mode IS NULL OR business_mode IN ('SELF', 'DISTRIBUTION')),\n\tCONSTRAINT ck_accounts_account_status_valid CHECK (status IN ('IN_STOCK', 'INSTALLMENT', 'SOLD', 'VOID')),\n\tCONSTRAINT ck_accounts_cost_nonneg CHECK (cost_amount >= 0),\n\tCONSTRAINT ck_accounts_account_inventory_context_valid CHECK (business_mode IS NULL OR inventory_type IS NULL OR (business_mode = 'SELF' AND inventory_type = 'RECOVERY') OR (business_mode = 'DISTRIBUTION' AND inventory_type IN ('PICKUP', 'CONSIGNMENT')))\n)"
m10__STOCKS_DDL_WITH_UNIQUE = m10__STOCKS_DDL.replace('\tCONSTRAINT ck_accounts_account_status_valid', '\tCONSTRAINT uq_accounts_game_account UNIQUE (game_account),\n\tCONSTRAINT ck_accounts_account_status_valid')
m10__INDEXES = ('CREATE UNIQUE INDEX uq_accounts_stock_no ON {token} (stock_no)', 'CREATE INDEX ix_stocks_status ON {token} (status)')
def m10__rebuild(ddl: str) -> None:
    op.execute(ddl.replace('{token}', 'stocks_new'))
    op.execute('INSERT INTO stocks_new (id, game_type, business_mode, inventory_type, game_account, game_password, channel_region, bound_phone, has_secondary, platform, status, buy_date, cost_amount, note, created_by, updated_by, created_at, updated_at, account_description, account_images, form_extra, value_added_service, stock_no) SELECT id, game_type, business_mode, inventory_type, game_account, game_password, channel_region, bound_phone, has_secondary, platform, status, buy_date, cost_amount, note, created_by, updated_by, created_at, updated_at, account_description, account_images, form_extra, value_added_service, stock_no FROM stocks')
    op.execute('DROP TABLE stocks')
    op.execute('ALTER TABLE stocks_new RENAME TO stocks')
    for index_sql in m10__INDEXES:
        op.execute(index_sql.replace('{token}', 'stocks'))
def downgrade() -> None:
    m10__rebuild(m10__STOCKS_DDL_WITH_UNIQUE)
m11_revision = '0011'
m11_down_revision = '0010'
m11_branch_labels = None
m11_depends_on = None
def downgrade() -> None:
    op.drop_column('order_form_fields', 'section')
m12_revision = '0012'
m12_down_revision = '0011'
m12_branch_labels = None
m12_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'ORDER' WHERE section = 'EXTRA'")
    op.execute("UPDATE order_form_fields SET section = 'ACCOUNT' WHERE section = 'ACCOUNT_PRODUCT'")
    op.execute("UPDATE order_form_fields SET section = 'CUSTOMER' WHERE section = 'PARTICIPANT'")
m13_revision = '0013'
m13_down_revision = '0012'
m13_branch_labels = None
m13_depends_on = None
m13_ACCOUNT_KEYS = ('game_type', 'game_account', 'game_password', 'channel_region', 'bound_phone', 'has_secondary', 'game_account_note', 'dfq_game_type', 'dfq_game_account', 'dfq_game_password', 'dfq_channel_region', 'dfq_bound_phone', 'dfq_has_secondary', 'dfq_account_note')
m13_PARTICIPANT_KEYS = ('customer_nickname', 'customer_source', 'customer_contact_name', 'customer_phone', 'customer_wechat', 'customer_qq', 'dfq_customer_nickname', 'dfq_customer_source', 'dfq_customer_contact', 'dfq_customer_phone', 'dfq_customer_qq', 'dfq_customer_wechat', 'dg_customer_nickname', 'dg_customer_source', 'dg_customer_contact', 'dg_customer_phone', 'dg_customer_qq', 'dg_customer_wechat', 'supplier_nickname', 'supplier_source', 'supplier_source_other', 'supplier_contact_name', 'supplier_phone', 'supplier_wechat', 'supplier_qq')
m13_BUSINESS_KEYS = ('intermediary_fee', 'intermediary_platform', 'intermediary_type', 'compensation_type', 'other_fee_name', 'other_fee_amount', 'other_fee_recipient', 'design_fee', 'qa500b_flag')
m13_FINANCE_KEYS = ('recovery_price', 'th_purchase_amount', 'th_receive_amount', 'dfq_purchase_price', 'dfq_down_payment', 'dfq_service_fee', 'dfq_periods', 'dfq_period_service_fee', 'dfq_period_amount', 'payment_pool_id', 'payment_recipient', 'payment_note')
def m13__update(keys: tuple[str, ...], section: str) -> None:
    values = ', '.join((f"'{key}'" for key in keys))
    op.execute(f"UPDATE order_form_fields SET section = '{section}' WHERE field_key IN ({values})")
def downgrade() -> None:
    all_keys = m13_ACCOUNT_KEYS + m13_PARTICIPANT_KEYS + m13_BUSINESS_KEYS + m13_FINANCE_KEYS
    m13__update(all_keys, 'EXTRA')
m14_revision = '0014'
m14_down_revision = '0013'
m14_branch_labels = None
m14_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET sort_order = sort_order - CASE section WHEN 'ACCOUNT_PRODUCT' THEN 1000 WHEN 'BUSINESS' THEN 2000 WHEN 'FINANCE' THEN 3000 WHEN 'EXTRA' THEN 4000 WHEN 'PARTICIPANT' THEN 5000 ELSE 6000 END WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ')")
m15_revision = '0015'
m15_down_revision = '0014'
m15_branch_labels = None
m15_depends_on = None
m15_RENAMES = {'dfq_game_type': 'game_type', 'dfq_game_account': 'game_account', 'dfq_game_password': 'game_password', 'dfq_channel_region': 'channel_region', 'dfq_bound_phone': 'bound_phone', 'dfq_has_secondary': 'has_secondary', 'dfq_account_note': 'game_account_note', 'dfq_customer_nickname': 'customer_nickname', 'dfq_customer_source': 'customer_source', 'dfq_customer_contact': 'customer_contact_name', 'dfq_customer_phone': 'customer_phone', 'dfq_customer_wechat': 'customer_wechat', 'dfq_customer_qq': 'customer_qq', 'dfq_note': 'note'}
def downgrade() -> None:
    for old_key, new_key in m15_RENAMES.items():
        op.execute(f"UPDATE order_form_fields SET field_key = '{old_key}' WHERE order_type_code = 'DFQ' AND field_key = '{new_key}'")
m16_revision = '0016'
m16_down_revision = '0015'
m16_branch_labels = None
m16_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'EXTRA' WHERE order_type_code = 'DFQ' AND field_key IN ('dfq_payment_pool_id', 'dfq_payment_recipient', 'dfq_payment_note')")
m17_revision = '0017'
m17_down_revision = '0016'
m17_branch_labels = None
m17_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET field_key = 'dfq_purchase_price' WHERE order_type_code = 'DFQ' AND field_key = 'recovery_price'")
m18_revision = '0018'
m18_down_revision = '0017'
m18_branch_labels = None
m18_depends_on = None
m18_RENAMES = {'dfq_payment_pool_id': 'payment_pool_id', 'dfq_payment_recipient': 'payment_recipient', 'dfq_payment_note': 'payment_note'}
def downgrade() -> None:
    for old_key, new_key in m18_RENAMES.items():
        op.execute(f"UPDATE order_form_fields SET field_key = '{old_key}' WHERE order_type_code = 'DFQ' AND field_key = '{new_key}'")
m19_revision = '0019'
m19_down_revision = '0018'
m19_branch_labels = None
m19_depends_on = None
def m19__update(order_types: tuple[str, ...], keys: tuple[str, ...], section: str) -> None:
    types = ', '.join((f"'{value}'" for value in order_types))
    fields = ', '.join((f"'{value}'" for value in keys))
    op.execute(f"UPDATE order_form_fields SET section = '{section}' WHERE order_type_code IN ({types}) AND field_key IN ({fields})")
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'EXTRA' WHERE order_type_code NOT IN ('HS', 'TH', 'DG', 'DFQ')")
m20_revision = '0020'
m20_down_revision = '0019'
m20_branch_labels = None
m20_depends_on = None
def downgrade() -> None:
    op.execute("DELETE FROM option_sets WHERE code = 'INTERMEDIARY_PLATFORM'")
m21_revision = '0021'
m21_down_revision = '0020'
m21_branch_labels = None
m21_depends_on = None
def downgrade() -> None:
    op.execute('UPDATE order_form_fields SET options = \'[{"value":"盼之","label":"盼之"},{"value":"千寻","label":"千寻"},{"value":"白情","label":"白情"},{"value":"螃蟹","label":"螃蟹"},{"value":"私下","label":"私下"},{"value":"其他","label":"其他"}]\' WHERE order_type_code IN (\'HS\', \'TH\') AND field_key = \'intermediary_platform\'')
    op.execute("UPDATE option_sets SET options = '[]' WHERE code = 'INTERMEDIARY_PLATFORM'")
m22_revision = '0022'
m22_down_revision = '0021'
m22_branch_labels = None
m22_depends_on = None
def downgrade() -> None:
    op.execute("DELETE FROM option_sets WHERE code IN ('INTERMEDIARY_TYPE', 'COMPENSATION_TYPE')")
m23_revision = '0023'
m23_down_revision = '0022'
m23_branch_labels = None
m23_depends_on = None
def downgrade() -> None:
    op.drop_column('game_type_options', 'channel_regions')
m24_revision = '0024'
m24_down_revision = '0023'
m24_branch_labels = None
m24_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE game_type_options SET channel_regions = NULL WHERE name IN ('王者荣耀', '和平精英', '原神')")
m25_revision = '0025'
m25_down_revision = '0024'
m25_branch_labels = None
m25_depends_on = None
m25__TABLES = ('customer_leads', 'counterparties', 'deposits', 'reconciliations', 'rebate_records', 'rebate_settlements', 'period_locks')
def downgrade() -> None:
    for table in reversed(m25__TABLES):
        op.drop_column(table, 'form_extra')
m26_revision = '0026'
m26_down_revision = '0025'
m26_branch_labels = None
m26_depends_on = None
m26__ROWS = (('HS', 185), ('DFQ', 75))
def downgrade() -> None:
    op.execute("DELETE FROM order_form_fields WHERE order_type_code IN ('HS', 'DFQ') AND field_key = 'bound_phone_owner'")
m27_revision = '0027'
m27_down_revision = '0026'
m27_branch_labels = None
m27_depends_on = None
m27_LABELS = {'DEPOSIT_CANCEL': '取消押金', 'REBATE_VOID': '作废返点', 'IMPORT_REJECT': '驳回导入批次'}
def downgrade() -> None:
    bind = op.get_bind()
    raw_options = bind.execute(text("SELECT options FROM option_sets WHERE code = 'AUDIT_ACTION'")).scalar_one_or_none()
    if raw_options is None:
        return
    options = raw_options if isinstance(raw_options, list) else json.loads(raw_options or '[]')
    options = [item for item in options if not isinstance(item, dict) or item.get('value') not in m27_LABELS]
    bind.execute(text("UPDATE option_sets SET options = :options WHERE code = 'AUDIT_ACTION'"), {'options': json.dumps(options, ensure_ascii=False)})
m28_revision = '0028'
m28_down_revision = '0027'
m28_branch_labels = None
m28_depends_on = None
def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("\n            UPDATE order_form_fields\n            SET label = '绑定手机号'\n            WHERE (order_type_code IN ('HS', 'TH', 'DG') AND field_key = 'bound_phone')\n               OR (order_type_code = 'DFQ' AND field_key = 'dfq_bound_phone')\n            "))
m29_revision = '0029_rename_intermediary_platform_to_trade_platform'
m29_down_revision = '0028'
m29_branch_labels = None
m29_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET label = '经手平台' WHERE field_key = 'intermediary_platform'")
m30_revision = '0030_add_customer_source_other_field'
m30_down_revision = '0029_rename_intermediary_platform_to_trade_platform'
m30_branch_labels = None
m30_depends_on = None
def downgrade() -> None:
    op.execute("DELETE FROM order_form_fields WHERE order_type_code = 'DFQ' AND field_key = 'customer_source_other'")
    op.execute("UPDATE order_form_fields SET section = 'EXTRA' WHERE (order_type_code = 'HS' AND field_key = 'customer_source_other') OR (order_type_code = 'DG' AND field_key = 'dg_customer_source_other')")
m31_revision = '0031_move_order_delivery_fields_to_delivery_section'
m31_down_revision = '0030_add_customer_source_other_field'
m31_branch_labels = None
m31_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'ACCOUNT_PRODUCT' WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ') AND field_key IN ('bound_phone', 'bound_phone_owner')")
    op.execute("UPDATE order_form_fields SET section = 'BUSINESS' WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ') AND field_key IN ('intermediary_platform', 'intermediary_type', 'compensation_type')")
m32_revision = '0032_move_installment_delivery_fields_to_delivery_section'
m32_down_revision = '0031_move_order_delivery_fields_to_delivery_section'
m32_branch_labels = None
m32_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = CASE field_key WHEN 'delivery_mode' THEN 'BUSINESS' ELSE 'EXTRA' END WHERE order_type_code = 'INSTDELIVER' AND field_key IN ('delivery_mode', 'delivered_on', 'note')")
m33_revision = '0033_move_inventory_delivery_fields_to_delivery_section'
m33_down_revision = '0032_move_installment_delivery_fields_to_delivery_section'
m33_branch_labels = None
m33_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'ACCOUNT_PRODUCT' WHERE order_type_code = 'SALE' AND field_key IN ('bound_phone', 'bound_phone_owner')")
    op.execute("UPDATE order_form_fields SET section = 'BUSINESS' WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'")
m34_revision = '0034_seed_inventory_sale_delivery_fields'
m34_down_revision = '0033_move_inventory_delivery_fields_to_delivery_section'
m34_branch_labels = None
m34_depends_on = None
def downgrade() -> None:
    op.execute("DELETE FROM order_form_fields WHERE order_type_code = 'SALE' AND field_key IN ('bound_phone', 'bound_phone_owner')")
m35_revision = '0035_normalize_order_form_sections'
m35_down_revision = '0034_seed_inventory_sale_delivery_fields'
m35_branch_labels = None
m35_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'BUSINESS' WHERE order_type_code IN ('HS', 'TH') AND field_key IN ('intermediary_fee', 'other_fee_name', 'other_fee_amount', 'other_fee_recipient')")
    op.execute("UPDATE order_form_fields SET section = 'BUSINESS' WHERE order_type_code = 'SALE' AND field_key = 'payment_method'")
    op.execute("UPDATE order_form_fields SET is_active = 1 WHERE order_type_code IN ('HS', 'TH') AND field_key IN ('other_fee_name', 'other_fee_amount', 'other_fee_recipient', 'design_fee')")
m36_revision = '0036_remove_legacy_fee_fields'
m36_down_revision = '0035_normalize_order_form_sections'
m36_branch_labels = None
m36_depends_on = None
def downgrade() -> None:
    pass
m37_revision = '0037_reorder_order_form_fields'
m37_down_revision = '0036_remove_legacy_fee_fields'
m37_branch_labels = None
m37_depends_on = None
m37_FIELD_ORDER = {'HS': (('ACCOUNT_PRODUCT', ('game_type', 'game_account', 'game_password', 'channel_region', 'has_secondary', 'game_account_note')), ('DELIVER', ('bound_phone', 'bound_phone_owner', 'intermediary_platform', 'intermediary_type', 'compensation_type')), ('FINANCE', ('recovery_price', 'intermediary_fee', 'payment_pool_id', 'payment_recipient', 'payment_note')), ('EXTRA', ('note',)), ('PARTICIPANT', ('customer_nickname', 'customer_source', 'customer_contact_name', 'customer_phone', 'customer_wechat', 'customer_qq'))), 'TH': (('ACCOUNT_PRODUCT', ('game_type', 'game_account', 'game_password', 'channel_region', 'has_secondary', 'game_account_note')), ('DELIVER', ('bound_phone', 'bound_phone_owner', 'intermediary_platform', 'intermediary_type', 'compensation_type')), ('FINANCE', ('th_purchase_amount', 'th_receive_amount', 'intermediary_fee', 'payment_pool_id', 'payment_recipient', 'payment_note')), ('EXTRA', ('supplier_note',)), ('PARTICIPANT', ('supplier_nickname', 'supplier_source', 'supplier_source_other', 'supplier_contact_name', 'supplier_phone', 'supplier_wechat', 'supplier_qq'))), 'DG': (('ACCOUNT_PRODUCT', ('game_type', 'game_account', 'game_password', 'channel_region', 'has_secondary', 'game_account_note')), ('DELIVER', ('bound_phone', 'bound_phone_owner')), ('EXTRA', ('dg_note',)), ('PARTICIPANT', ('dg_customer_nickname', 'dg_customer_source', 'dg_customer_source_other', 'dg_customer_contact', 'dg_customer_phone', 'dg_customer_wechat', 'dg_customer_qq'))), 'DFQ': (('ACCOUNT_PRODUCT', ('game_type', 'game_account', 'game_password', 'channel_region', 'has_secondary', 'game_account_note')), ('DELIVER', ('bound_phone', 'bound_phone_owner')), ('FINANCE', ('recovery_price', 'dfq_down_payment', 'dfq_service_fee', 'dfq_periods', 'dfq_period_service_fee', 'dfq_period_amount', 'payment_pool_id', 'payment_recipient', 'payment_note')), ('EXTRA', ('note',)), ('PARTICIPANT', ('customer_nickname', 'customer_source', 'customer_source_other', 'customer_contact_name', 'customer_phone', 'customer_wechat', 'customer_qq'))), 'SALE': (('DELIVER', ('bound_phone', 'bound_phone_owner')), ('FINANCE', ('amount', 'payment_method', 'pool_id', 'down_payment', 'service_fee', 'periods', 'per_period_service_fee', 'per_period', 'first_due_on')), ('EXTRA', ('note',)), ('PARTICIPANT', ('customer_id',))), 'CONSIGN': (('DELIVER', ('platform_ids',)),), 'INSTDELIVER': (('DELIVER', ('delivery_mode', 'delivered_on', 'note')),)}
def downgrade() -> None:
    pass
m38_revision = '0038_move_participant_section_before_extra'
m38_down_revision = '0037_reorder_order_form_fields'
m38_branch_labels = None
m38_depends_on = None
def downgrade() -> None:
    pass
m39_revision = '0039_move_party_notes_to_participant_section'
m39_down_revision = '0038_move_participant_section_before_extra'
m39_branch_labels = None
m39_depends_on = None
m39_PARTY_NOTES = {'HS': 'note', 'TH': 'supplier_note', 'DG': 'dg_note', 'DFQ': 'note'}
def downgrade() -> None:
    for order_type, field_key in m39_PARTY_NOTES.items():
        op.execute(f"UPDATE order_form_fields SET section = 'EXTRA', sort_order = 5010 WHERE order_type_code = '{order_type}' AND field_key = '{field_key}'")
m40_revision = '0040_keep_only_customer_supplier_notes'
m40_down_revision = '0039_move_party_notes_to_participant_section'
m40_branch_labels = None
m40_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'PARTICIPANT', sort_order = 4900 WHERE order_type_code = 'DG' AND field_key = 'dg_note'")
    op.execute("UPDATE order_form_fields SET section = 'PARTICIPANT', sort_order = 4900 WHERE order_type_code = 'DFQ' AND field_key = 'note'")
m41_revision = '0041_seed_party_source_option_set'
m41_down_revision = '0040_keep_only_customer_supplier_notes'
m41_branch_labels = None
m41_depends_on = None
m41_PARTY_SOURCE_OPTIONS = [{'value': '自营', 'label': '自营'}, {'value': '微博', 'label': '微博'}, {'value': '小红书', 'label': '小红书'}, {'value': '闲鱼', 'label': '闲鱼'}, {'value': '同行推荐', 'label': '同行推荐'}, {'value': '其他', 'label': '其他'}]
def downgrade() -> None:
    op.execute("DELETE FROM option_sets WHERE code = 'PARTY_SOURCE'")
m42_revision = '0042_split_party_source_option_sets'
m42_down_revision = '0041_seed_party_source_option_set'
m42_branch_labels = None
m42_depends_on = None
m42_SOURCE_OPTIONS = [{'value': '自营', 'label': '自营'}, {'value': '微博', 'label': '微博'}, {'value': '小红书', 'label': '小红书'}, {'value': '闲鱼', 'label': '闲鱼'}, {'value': '同行推荐', 'label': '同行推荐'}, {'value': '其他', 'label': '其他'}]
def downgrade() -> None:
    op.execute("DELETE FROM option_sets WHERE code IN ('CUSTOMER_SOURCE', 'SUPPLIER_SOURCE')")
m43_revision = '0043_rename_payment_pool_label'
m43_down_revision = '0042_split_party_source_option_sets'
m43_branch_labels = None
m43_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET label = '付款资金账户' WHERE field_key = 'payment_pool_id' AND label = '资金账户'")
m44_revision = '0044_add_order_field_fund_nature'
m44_down_revision = '0043_rename_payment_pool_label'
m44_branch_labels = None
m44_depends_on = None
def downgrade() -> None:
    op.drop_column('order_form_fields', 'fund_nature')
m45_revision = '0045_add_flow_direction_to_order_fields'
m45_down_revision = '0044_add_order_field_fund_nature'
m45_branch_labels = None
m45_depends_on = None
def downgrade() -> None:
    op.add_column('order_form_fields', sa.Column('fund_nature', sa.String(length=16), nullable=True))
    op.drop_column('order_form_fields', 'flow_direction')
m46_revision = '0046_limit_order_flow_direction_scope'
m46_down_revision = '0045_add_flow_direction_to_order_fields'
m46_branch_labels = None
m46_depends_on = None
def downgrade() -> None:
    pass
m47_revision = '0047_remove_payment_recipient_field'
m47_down_revision = '0046_limit_order_flow_direction_scope'
m47_branch_labels = None
m47_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET is_active = 1 WHERE field_key = 'payment_recipient'")
m48_revision = '0048_add_base_flow_direction'
m48_down_revision = '0047_remove_payment_recipient_field'
m48_branch_labels = None
m48_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET flow_direction = NULL WHERE flow_direction = 'BASE'")
m49_revision = '0049_delete_payment_recipient_fields'
m49_down_revision = '0048_add_base_flow_direction'
m49_branch_labels = None
m49_depends_on = None
def downgrade() -> None:
    pass
m50_revision = '0050_set_order_cancel_incoming_flow'
m50_down_revision = '0049_delete_payment_recipient_fields'
m50_branch_labels = None
m50_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET flow_direction = NULL WHERE order_type_code = 'ORDERCANC' AND field_key = 'cancel_amount'")
m51_revision = '0051_add_list_column_configs'
m51_down_revision = '0050_set_order_cancel_incoming_flow'
m51_branch_labels = None
m51_depends_on = None
def downgrade() -> None:
    op.drop_table('list_column_configs')
m52_revision = '0052_add_list_column_width_fixed'
m52_down_revision = '0051_add_list_column_configs'
m52_branch_labels = None
m52_depends_on = None
def downgrade() -> None:
    with op.batch_alter_table('list_column_configs') as batch:
        batch.drop_column('fixed')
        batch.drop_column('width')
m53_revision = '0053_add_list_custom_columns'
m53_down_revision = '0052_add_list_column_width_fixed'
m53_branch_labels = None
m53_depends_on = None
def downgrade() -> None:
    op.drop_table('list_custom_columns')
m54_revision = '0054_seed_allocation_form_fields'
m54_down_revision = '0053_add_list_custom_columns'
m54_branch_labels = None
m54_depends_on = None
m54_SEED = (('employee', '姓名', 'SELECT', True, 10), ('role', '角色', 'SELECT', False, 20), ('allocation_rate', '比例', 'TEXT', False, 30), ('allocation_amount', '金额', 'TEXT', False, 40))
def downgrade() -> None:
    session = Session(bind=op.get_bind())
    try:
        session.query(OrderFormField).filter(OrderFormField.order_type_code == 'ALLOCATION', OrderFormField.field_key.in_([row[0] for row in m54_SEED])).delete(synchronize_session=False)
        session.commit()
    finally:
        session.close()
m55_revision = '0055_move_consignment_to_operation_section'
m55_down_revision = '0054_seed_allocation_form_fields'
m55_branch_labels = None
m55_depends_on = None
def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'DELIVER' WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'")
m56_revision = '0056_merge_distribution_installment_types'
m56_down_revision = '0055_move_consignment_to_operation_section'
m56_branch_labels = None
m56_depends_on = None
m56_LEGACY_CONTRACT_TYPES = ('PICKUP_SALE', 'CONSIGNMENT_SALE')
def downgrade() -> None:
    pass
m57_revision = '0057_update_refund_cashflow_form_fields'
m57_down_revision = '0056_merge_distribution_installment_types'
m57_branch_labels = None
m57_depends_on = None
def downgrade() -> None:
    session = Session(bind=op.get_bind())
    try:
        session.query(OrderFormField).filter(OrderFormField.order_type_code == 'REFUND', OrderFormField.field_key.in_(['occurred_on', 'direction'])).delete(synchronize_session=False)
        responsibility = session.scalar(select(OrderFormField).where(OrderFormField.order_type_code == 'REFUND', OrderFormField.field_key == 'refund_responsibility'))
        if responsibility is not None:
            responsibility.is_active = True
        session.commit()
    finally:
        session.close()
m58_revision = '0058_add_rebate_operator_user_ids'
m58_down_revision = '0057_update_refund_cashflow_form_fields'
m58_branch_labels = None
m58_depends_on = None
def downgrade() -> None:
    op.drop_column('rebate_records', 'operator_user_ids')
m59_revision = '0059_remove_rebate_expected_on'
m59_down_revision = '0058_add_rebate_operator_user_ids'
m59_branch_labels = None
m59_depends_on = None
def downgrade() -> None:
    with op.batch_alter_table('rebate_records') as batch:
        batch.add_column(sa.Column('expected_on', sa.Date(), nullable=True))
        batch.create_index('ix_rebate_records_expected_status', ['expected_on', 'status'], unique=False)
m60_revision = '0060_remove_rebate_settlement_history'
m60_down_revision = '0059_remove_rebate_expected_on'
m60_branch_labels = None
m60_depends_on = None
def downgrade() -> None:
    pass
m61_revision = '0061_remove_orphan_rebate_cashflows'
m61_down_revision = '0060_remove_rebate_settlement_history'
m61_branch_labels = None
m61_depends_on = None
def downgrade() -> None:
    pass
m62_revision = '0062_normalize_rebate_status'
m62_down_revision = '0061_remove_orphan_rebate_cashflows'
m62_branch_labels = None
m62_depends_on = None
def downgrade() -> None:
    pass
m63_revision = '0063_remove_legacy_rebate_configs'
m63_down_revision = '0062_normalize_rebate_status'
m63_branch_labels = None
m63_depends_on = None
def downgrade() -> None:
    pass
m64_revision = '0064_expand_buy_rebate_scope'
m64_down_revision = '0063_remove_legacy_rebate_configs'
m64_branch_labels = None
m64_depends_on = None
def downgrade() -> None:
    pass
m65_revision = '0065_allow_split_cashflow_per_event'
m65_down_revision = '0064_expand_buy_rebate_scope'
m65_branch_labels = None
m65_depends_on = None
def downgrade() -> None:
    with op.batch_alter_table('cashflow') as batch_op:
        batch_op.create_unique_constraint('uq_cashflow_event', ['order_event_id'])
m66_revision = '0066_add_order_form_section_labels'
m66_down_revision = '0065_allow_split_cashflow_per_event'
m66_branch_labels = None
m66_depends_on = None
def downgrade() -> None:
    op.drop_table('order_form_section_labels')
m67_revision = '0067_drop_period_locks'
m67_down_revision = '0066_add_order_form_section_labels'
m67_branch_labels = None
m67_depends_on = None
def downgrade() -> None:
    op.create_table('period_locks', sa.Column('id', sa.Integer(), autoincrement=True, nullable=False), sa.Column('period', sa.String(length=7), nullable=False), sa.Column('locked_at', sa.DateTime(), nullable=False, server_default=sa.func.now()), sa.Column('locked_by', sa.String(length=64), nullable=False), sa.Column('note', sa.Text(), nullable=True), sa.Column('form_extra', sa.JSON(), nullable=True), sa.CheckConstraint("length(period) = 7 AND substr(period, 5, 1) = '-'", name='period_lock_format_valid'), sa.PrimaryKeyConstraint('id', name=op.f('pk_period_locks')), sa.UniqueConstraint('period', name='uq_period_locks_period'))
m68_revision = '0068_add_independent_inventory_status'
m68_down_revision = '0067_drop_period_locks'
m68_branch_labels = None
m68_depends_on = None
def downgrade() -> None:
    with op.batch_alter_table('stocks') as batch_op:
        batch_op.drop_constraint('account_inventory_status_valid', type_='check')
        batch_op.drop_column('inventory_status')
m69_revision = '0069_split_order_installment_status'
m69_down_revision = '0068_add_independent_inventory_status'
m69_branch_labels = None
m69_depends_on = None
def downgrade() -> None:
    with op.batch_alter_table('orders', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_orders_order_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_orders_order_status_valid'), "status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')")
    with op.batch_alter_table('stocks', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_accounts_account_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_accounts_account_status_valid'), "status IN ('IN_STOCK', 'INSTALLMENT', 'SOLD', 'VOID')")
m70_revision = '0070_hide_internal_installment_pending'
m70_down_revision = '0069_split_order_installment_status'
m70_branch_labels = None
m70_depends_on = None
m70__PUBLIC_INSTALLMENT_STATUS_OPTIONS = '[{"value":"ACTIVE","label":"还款中"},{"value":"OVERDUE","label":"逾期"},{"value":"SETTLED","label":"已结清"},{"value":"DELIVERED","label":"已交付"},{"value":"DEFAULTED","label":"违约"},{"value":"CLOSED","label":"已关闭"},{"value":"CANCELLED","label":"已取消"}]'
m70__LEGACY_INSTALLMENT_STATUS_OPTIONS = '[{"value":"PENDING","label":"待首付"},{"value":"ACTIVE","label":"收款中"},{"value":"OVERDUE","label":"逾期"},{"value":"SETTLED","label":"已结清"},{"value":"DELIVERED","label":"已交付"},{"value":"DEFAULTED","label":"违约"},{"value":"CLOSED","label":"已关闭"},{"value":"CANCELLED","label":"已取消"}]'
def m70__set_options(options: str) -> None:
    op.execute(sa.text("UPDATE option_sets SET options = :options WHERE code = 'INSTALLMENT_STATUS'").bindparams(options=options))
def downgrade() -> None:
    m70__set_options(m70__LEGACY_INSTALLMENT_STATUS_OPTIONS)
m71_revision = '0071_rename_account_waiting_status'
m71_down_revision = '0070_hide_internal_installment_pending'
m71_branch_labels = None
m71_depends_on = None
def downgrade() -> None:
    with op.batch_alter_table('stocks', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_accounts_account_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_accounts_account_status_valid'), "status IN ('IN_STOCK', 'WAITING', 'SOLD', 'VOID')")
    op.execute(sa.text("UPDATE stocks SET status = 'IN_STOCK' WHERE status = 'WAITING'"))
    with op.batch_alter_table('stocks', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_accounts_account_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_accounts_account_status_valid'), "status IN ('IN_STOCK', 'SOLD', 'VOID')")


def upgrade() -> None:
        # ===== 0002_value_added_service_and_installment_no.py :: upgrade =====
    bind = op.get_bind()
    op.add_column('accounts', sa.Column('value_added_service', sa.String(32), nullable=True))
    bind.execute(text("INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) VALUES ('INSTALLMENT', 'FQ', 4, 0)"))
    bind.execute(text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"), {'options': m2__SEQ_OPTIONS_NEW})
    bind.execute(text("UPDATE option_sets SET label = '业务类型' WHERE code = 'INVENTORY_TYPE'"))
    bind.execute(text('INSERT INTO option_sets (code, label, "group", editable, options, description, created_by, updated_by) VALUES (\'VALUE_ADDED_SERVICE\', \'增值服务\', \'INVENTORY\', 0, :options, \'后端服务层校验取值，只读；STOCK_SALE=分期/ADVANCE_PURCHASE=代分期\', \'system\', \'system\')'), {'options': m2__VAS_OPTIONS})
    bind.execute(text(m2__BACKFILL_ACCOUNTS))
    bind.execute(text(m2__BACKFILL_ORDER_LINK))
        # ===== 0003_cashflow_direction_sequences.py :: upgrade =====
    bind = op.get_bind()
    m3__rebuild_table(padding_max=6, value_max=999999)
    bind.execute(text("INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) VALUES ('CASHFLOW_OUT', 'ZC', 5, 0), ('CASHFLOW_IN', 'SR', 5, 0)"))
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key = 'CASHFLOW'"))
    bind.execute(text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"), {'options': m3__SEQ_OPTIONS_NEW})
        # ===== 0004_account_stock_no.py :: upgrade =====
    bind = op.get_bind()
    op.add_column('accounts', sa.Column('stock_no', sa.String(32), nullable=True))
    rows = bind.execute(text('SELECT id FROM accounts ORDER BY id ASC')).fetchall()
    n = 0
    for aid, in rows:
        n += 1
        bind.execute(text('UPDATE accounts SET stock_no = :no WHERE id = :id'), {'no': f'KU{n:04d}', 'id': aid})
    seq_id = bind.execute(text('SELECT COALESCE(MAX(id), 0) + 1 FROM document_sequences')).scalar()
    bind.execute(text("INSERT INTO document_sequences (id, sequence_key, prefix, padding, current_value, created_at, updated_at) VALUES (:id, 'STOCK_NO', 'KU', 4, :cur, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"), {'id': int(seq_id), 'cur': n})
    op.create_index('uq_accounts_stock_no', 'accounts', ['stock_no'], unique=True)
        # ===== 0005_customer_source_optional.py :: upgrade =====
    bind = op.get_bind()
    bind.execute(text("UPDATE order_form_fields SET required = 0, field_type = 'TEXT', options = NULL WHERE field_key IN ('customer_source', 'dg_customer_source', 'dfq_customer_source')"))
    bind.execute(text("DELETE FROM order_form_fields WHERE field_key IN ('customer_source_other', 'dg_customer_source_other')"))
        # ===== 0006_stock_no_ku5.py :: upgrade =====
    m6__renumber(m6__RENUMBER_TO_KU5)
    op.execute(text("UPDATE document_sequences SET prefix = 'KU_', padding = 5, current_value = (SELECT COUNT(*) FROM accounts), updated_at = CURRENT_TIMESTAMP WHERE sequence_key = 'STOCK_NO'"))
        # ===== 0007_orders_snapshot_all_types.py :: upgrade =====
    m7__rebuild(m7__SNAPSHOT_CHECK_NEW)
        # ===== 0008_orders_drop_flat_account_columns.py :: upgrade =====
    op.execute(text(m8__FOLD_FLAT_INTO_SNAPSHOT))
    m8__rebuild_without_flat_columns()
        # ===== 0009_accounts_to_stocks.py :: upgrade =====
    op.execute(text('ALTER TABLE accounts RENAME TO stocks'))
    for old_name in m9__index_names():
        suffix = old_name.removeprefix('ix_accounts_')
        op.execute(text(f'DROP INDEX {old_name}'))
        op.execute(text(f'CREATE INDEX ix_stocks_{suffix} ON stocks ({suffix})'))
        # ===== 0010_stocks_game_account_not_unique.py :: upgrade =====
    m10__rebuild(m10__STOCKS_DDL)
        # ===== 0011_order_form_field_section.py :: upgrade =====
    op.add_column('order_form_fields', sa.Column('section', sa.String(length=16), nullable=False, server_default='ORDER'))
        # ===== 0012_normalize_order_form_field_sections.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'EXTRA' WHERE section = 'ORDER'")
    op.execute("UPDATE order_form_fields SET section = 'ACCOUNT_PRODUCT' WHERE section = 'ACCOUNT'")
    op.execute("UPDATE order_form_fields SET section = 'PARTICIPANT' WHERE section = 'CUSTOMER'")
        # ===== 0013_assign_order_form_field_sections.py :: upgrade =====
    m13__update(m13_ACCOUNT_KEYS, 'ACCOUNT_PRODUCT')
    m13__update(m13_PARTICIPANT_KEYS, 'PARTICIPANT')
    m13__update(m13_BUSINESS_KEYS, 'BUSINESS')
    m13__update(m13_FINANCE_KEYS, 'FINANCE')
        # ===== 0014_order_form_field_section_sort.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET sort_order = CASE section WHEN 'ACCOUNT_PRODUCT' THEN 1000 WHEN 'BUSINESS' THEN 2000 WHEN 'FINANCE' THEN 3000 WHEN 'EXTRA' THEN 4000 WHEN 'PARTICIPANT' THEN 5000 ELSE 6000 END + sort_order WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ')")
        # ===== 0015_unify_dfq_shared_field_keys.py :: upgrade =====
    for old_key, new_key in m15_RENAMES.items():
        op.execute(f"UPDATE order_form_fields SET field_key = '{new_key}' WHERE order_type_code = 'DFQ' AND field_key = '{old_key}'")
        # ===== 0016_fix_dfq_payment_field_sections.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'FINANCE' WHERE order_type_code = 'DFQ' AND field_key IN ('dfq_payment_pool_id', 'dfq_payment_recipient', 'dfq_payment_note')")
        # ===== 0017_unify_dfq_purchase_price_key.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET field_key = 'recovery_price' WHERE order_type_code = 'DFQ' AND field_key = 'dfq_purchase_price'")
        # ===== 0018_unify_dfq_payment_field_keys.py :: upgrade =====
    for old_key, new_key in m18_RENAMES.items():
        op.execute(f"UPDATE order_form_fields SET field_key = '{new_key}' WHERE order_type_code = 'DFQ' AND field_key = '{old_key}'")
        # ===== 0019_assign_other_form_field_sections.py :: upgrade =====
    m19__update(('CUSTOMER',), ('display_name', 'contact_name', 'phone', 'wechat', 'qq', 'trade_role', 'referrer'), 'PARTICIPANT')
    m19__update(('COUNTERPARTY',), ('display_name', 'type', 'contact_name', 'phone', 'wechat'), 'PARTICIPANT')
    m19__update(('LEAD',), ('customer_id',), 'PARTICIPANT')
    m19__update(('SALE',), ('customer_id',), 'PARTICIPANT')
    for order_type in ('FUNDDEPOSIT', 'FUNDFLOW', 'FUNDLOCK', 'FUNDLOSS', 'FUNDRECON', 'FUNDREJECT', 'FUNDRELEASE', 'FUNDREPAIR', 'FUNDREVERSE', 'FUNDTRANSFER', 'CASHFLOW', 'STUDIOEXP'):
        op.execute(f"UPDATE order_form_fields SET section = 'FINANCE' WHERE order_type_code = '{order_type}'")
    m19__update(('REBATE', 'REBREVERSE', 'REBSETTLE', 'INVREBATE', 'INVREFUND'), ('source_order_id', 'rebate_type', 'base_amount', 'rate', 'collected_on', 'reversed_on', 'reason', 'gross_amount', 'platform_fee', 'pool_id', 'settled_on', 'refund_amount'), 'FINANCE')
    m19__update(('SALE',), ('amount', 'pool_id', 'down_payment', 'service_fee', 'periods', 'per_period_service_fee', 'per_period', 'first_due_on'), 'FINANCE')
    m19__update(('INSTPAY', 'INSTRECOVER', 'INSTRESALE', 'INSTSETTLE', 'INSTWAIVE'), ('period_no', 'amount', 'paid_on', 'occurred_on', 'resale_order_id', 'waived_on'), 'FINANCE')
    m19__update(('REFUND', 'ORDERCANC'), ('amount', 'cancel_amount'), 'FINANCE')
    m19__update(('ORDEREDIT',), ('snap_game_account', 'snap_game_type', 'snap_game_password', 'snap_channel_region', 'snap_bound_phone', 'snap_note'), 'ACCOUNT_PRODUCT')
    m19__update(('ORDEREDIT', 'ORDERLINK', 'LEAD', 'SALE', 'INSTDELIVER', 'CONSIGN'), ('snap_platform', 'trade_date', 'relation_type', 'split_ratio', 'split_amount', 'request_type', 'target', 'payment_method', 'delivery_mode', 'platform_ids'), 'BUSINESS')
    m19__update(('LEAD',), ('budget',), 'FINANCE')
        # ===== 0020_seed_intermediary_platform_option_set.py :: upgrade =====
    op.execute('INSERT INTO option_sets (code, label, "group", editable, options, description) SELECT \'INTERMEDIARY_PLATFORM\', \'经手平台\', \'BUSINESS\', 1, \'[]\', \'回收、提号等业务的经手平台主数据\' WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = \'INTERMEDIARY_PLATFORM\')')
        # ===== 0021_move_intermediary_platform_options.py :: upgrade =====
    op.execute('UPDATE option_sets SET options = \'[{"value":"盼之","label":"盼之"},{"value":"千寻","label":"千寻"},{"value":"白情","label":"白情"},{"value":"螃蟹","label":"螃蟹"},{"value":"私下","label":"私下"},{"value":"其他","label":"其他"}]\' WHERE code = \'INTERMEDIARY_PLATFORM\'')
    op.execute("UPDATE order_form_fields SET options = NULL WHERE order_type_code IN ('HS', 'TH') AND field_key = 'intermediary_platform'")
        # ===== 0022_move_intermediary_type_dictionaries.py :: upgrade =====
    op.execute('INSERT INTO option_sets (code, label, "group", editable, options, description) SELECT \'INTERMEDIARY_TYPE\', \'中介类型\', \'BUSINESS\', 1, \'[{"value":"普中","label":"普中"},{"value":"包赔","label":"包赔"}]\', \'中介费用类型\' WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = \'INTERMEDIARY_TYPE\')')
    op.execute('INSERT INTO option_sets (code, label, "group", editable, options, description) SELECT \'COMPENSATION_TYPE\', \'包赔类型\', \'BUSINESS\', 1, \'[{"value":"shoubao","label":"首保"},{"value":"xubao","label":"续保"},{"value":"zhuanxu","label":"转续"}]\', \'包赔保障类型\' WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = \'COMPENSATION_TYPE\')')
    op.execute("UPDATE order_form_fields SET options = NULL WHERE order_type_code IN ('HS', 'TH') AND field_key IN ('intermediary_type', 'compensation_type')")
        # ===== 0023_game_type_channel_regions.py :: upgrade =====
    op.add_column('game_type_options', sa.Column('channel_regions', sa.JSON(), nullable=True))
        # ===== 0024_seed_game_type_channel_regions.py :: upgrade =====
    mappings = {'王者荣耀': '["安卓QQ","安卓微信","苹果微信","苹果QQ"]', '和平精英': '["安卓QQ","安卓微信","苹果微信","苹果QQ"]', '原神': '["官服","B服"]'}
    for name, regions in mappings.items():
        op.execute(f"UPDATE game_type_options SET channel_regions = '{regions}' WHERE name = '{name}'")
        # ===== 0025_form_extra_all_scopes.py :: upgrade =====
    for table in m25__TABLES:
        op.add_column(table, sa.Column('form_extra', sa.JSON(), nullable=True))
        # ===== 0026_seed_phone_binding_owner_field.py :: upgrade =====
    for order_type_code, sort_order in m26__ROWS:
        op.execute(f"\n            INSERT INTO order_form_fields\n                (order_type_code, field_key, label, field_type, required, is_active,\n                 sort_order, locked, is_custom, created_by, updated_by)\n            SELECT '{order_type_code}', 'bound_phone_owner', '手机号绑定人', 'TEXT', 0, 1,\n                   {sort_order}, 1, 0, 'system', 'system'\n            WHERE NOT EXISTS (\n                SELECT 1 FROM order_form_fields\n                WHERE order_type_code = '{order_type_code}' AND field_key = 'bound_phone_owner'\n            )\n            ")
        # ===== 0027_complete_audit_action_labels.py :: upgrade =====
    bind = op.get_bind()
    raw_options = bind.execute(text("SELECT options FROM option_sets WHERE code = 'AUDIT_ACTION'")).scalar_one_or_none()
    if raw_options is None:
        return
    options = raw_options if isinstance(raw_options, list) else json.loads(raw_options or '[]')
    existing = {item.get('value') for item in options if isinstance(item, dict)}
    for value, label in m27_LABELS.items():
        if value in existing:
            for item in options:
                if isinstance(item, dict) and item.get('value') == value:
                    item['label'] = label
        else:
            options.append({'value': value, 'label': label})
    bind.execute(text("UPDATE option_sets SET options = :options WHERE code = 'AUDIT_ACTION'"), {'options': json.dumps(options, ensure_ascii=False)})
        # ===== 0028_rename_bound_phone_field.py :: upgrade =====
    bind = op.get_bind()
    bind.execute(text("\n            UPDATE order_form_fields\n            SET label = '换绑手机号'\n            WHERE (order_type_code IN ('HS', 'TH', 'DG') AND field_key = 'bound_phone')\n               OR (order_type_code = 'DFQ' AND field_key = 'dfq_bound_phone')\n            "))
        # ===== 0029_rename_intermediary_platform_to_trade_platform.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET label = '交易平台' WHERE field_key = 'intermediary_platform'")
        # ===== 0030_add_customer_source_other_field.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'PARTICIPANT' WHERE (order_type_code = 'HS' AND field_key = 'customer_source_other') OR (order_type_code = 'DG' AND field_key = 'dg_customer_source_other')")
    op.execute('INSERT INTO order_form_fields (order_type_code, field_key, label, field_type, options, required, required_when, is_active, sort_order, locked, is_custom, section, note) SELECT \'DFQ\', \'customer_source_other\', \'其他来源\', \'TEXT\', NULL, 0, \'{"field": "customer_source", "op": "eq", "values": ["其他"]}\', 1, 225, 0, 0, \'PARTICIPANT\', NULL WHERE NOT EXISTS (SELECT 1 FROM order_form_fields WHERE order_type_code = \'DFQ\' AND field_key = \'customer_source_other\')')
        # ===== 0031_move_order_delivery_fields_to_delivery_section.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'DELIVER' WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ') AND field_key IN ('bound_phone', 'bound_phone_owner', 'intermediary_platform', 'intermediary_type', 'compensation_type')")
        # ===== 0032_move_installment_delivery_fields_to_delivery_section.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'DELIVER' WHERE order_type_code = 'INSTDELIVER' AND field_key IN ('delivery_mode', 'delivered_on', 'note')")
        # ===== 0033_move_inventory_delivery_fields_to_delivery_section.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'DELIVER' WHERE order_type_code = 'SALE' AND field_key IN ('bound_phone', 'bound_phone_owner')")
    op.execute("UPDATE order_form_fields SET section = 'DELIVER' WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'")
        # ===== 0034_seed_inventory_sale_delivery_fields.py :: upgrade =====
    for field_key, label, sort_order in (('bound_phone', '换绑手机号', 10), ('bound_phone_owner', '手机号绑定人', 20)):
        op.execute(f"INSERT INTO order_form_fields (order_type_code, field_key, label, field_type, options, required, required_when, is_active, sort_order, locked, is_custom, section, note, created_by, updated_by) SELECT 'SALE', '{field_key}', '{label}', 'TEXT', NULL, 0, NULL, 1, {sort_order}, 0, 0, 'DELIVER', NULL, 'system', 'system' WHERE NOT EXISTS (SELECT 1 FROM order_form_fields WHERE order_type_code = 'SALE' AND field_key = '{field_key}')")
        # ===== 0035_normalize_order_form_sections.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'FINANCE' WHERE order_type_code IN ('HS', 'TH') AND field_key IN ('intermediary_fee', 'other_fee_name', 'other_fee_amount', 'other_fee_recipient')")
    op.execute("UPDATE order_form_fields SET section = 'FINANCE' WHERE order_type_code = 'SALE' AND field_key = 'payment_method'")
    op.execute("UPDATE order_form_fields SET is_active = 0 WHERE order_type_code IN ('HS', 'TH') AND field_key IN ('other_fee_name', 'other_fee_amount', 'other_fee_recipient', 'design_fee')")
        # ===== 0036_remove_legacy_fee_fields.py :: upgrade =====
    op.execute("DELETE FROM order_form_fields WHERE order_type_code IN ('HS', 'TH') AND field_key IN ('design_fee', 'other_fee_name', 'other_fee_amount', 'other_fee_recipient')")
        # ===== 0037_reorder_order_form_fields.py :: upgrade =====
    for order_type, groups in m37_FIELD_ORDER.items():
        for section_index, (section, fields) in enumerate(groups, start=1):
            for field_index, field_key in enumerate(fields, start=1):
                sort_order = section_index * 1000 + field_index * 10
                op.execute(f"UPDATE order_form_fields SET section = '{section}', sort_order = {sort_order} WHERE order_type_code = '{order_type}' AND field_key = '{field_key}'")
        # ===== 0038_move_participant_section_before_extra.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET sort_order = 4000 + (sort_order % 1000) WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ', 'SALE') AND section = 'PARTICIPANT'")
    op.execute("UPDATE order_form_fields SET sort_order = 5000 + (sort_order % 1000) WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ', 'SALE') AND section = 'EXTRA'")
        # ===== 0039_move_party_notes_to_participant_section.py :: upgrade =====
    for order_type, field_key in m39_PARTY_NOTES.items():
        op.execute(f"UPDATE order_form_fields SET section = 'PARTICIPANT', sort_order = 4900 WHERE order_type_code = '{order_type}' AND field_key = '{field_key}'")
        # ===== 0040_keep_only_customer_supplier_notes.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'EXTRA', sort_order = 5010 WHERE order_type_code = 'DG' AND field_key = 'dg_note'")
    op.execute("UPDATE order_form_fields SET section = 'EXTRA', sort_order = 5010 WHERE order_type_code = 'DFQ' AND field_key = 'note'")
        # ===== 0041_seed_party_source_option_set.py :: upgrade =====
    options = json.dumps(m41_PARTY_SOURCE_OPTIONS, ensure_ascii=False)
    escaped = options.replace("'", "''")
    op.execute('INSERT INTO option_sets (code, label, "group", editable, options, description) SELECT \'PARTY_SOURCE\', \'参与方来源\', \'BUSINESS\', 1, \'' + escaped + "', '客户与供货方共用的来源选项' WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = 'PARTY_SOURCE')")
    op.execute("UPDATE order_form_fields SET options = '" + escaped + "' WHERE field_key IN ('customer_source', 'supplier_source', 'dg_customer_source')")
        # ===== 0042_split_party_source_option_sets.py :: upgrade =====
    options = json.dumps(m42_SOURCE_OPTIONS, ensure_ascii=False).replace("'", "''")
    op.execute("DELETE FROM option_sets WHERE code = 'PARTY_SOURCE'")
    for code, label, description in (('CUSTOMER_SOURCE', '客户来源主数据', '回收、代挂、代分期共用的客户来源选项'), ('SUPPLIER_SOURCE', '供货方来源主数据', '提号订单使用的供货方来源选项')):
        op.execute(f"""INSERT INTO option_sets (code, label, "group", editable, options, description) SELECT '{code}', '{label}', 'BUSINESS', 1, '{options}', '{description}' WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = '{code}')""")
    op.execute("UPDATE order_form_fields SET options = '" + options + "' WHERE field_key IN ('customer_source', 'dg_customer_source')")
    op.execute("UPDATE order_form_fields SET options = '" + options + "' WHERE field_key = 'supplier_source'")
        # ===== 0043_rename_payment_pool_label.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET label = '资金账户' WHERE field_key = 'payment_pool_id' AND label = '付款资金账户'")
        # ===== 0044_add_order_field_fund_nature.py :: upgrade =====
    op.add_column('order_form_fields', sa.Column('fund_nature', sa.String(length=16), nullable=True))
    op.execute("UPDATE order_form_fields SET fund_nature = 'BUSINESS' WHERE section = 'FINANCE' AND field_key IN ('recovery_price','th_purchase_amount','th_receive_amount','intermediary_fee','amount','down_payment','service_fee','per_period_service_fee','per_period','dfq_down_payment','dfq_service_fee','dfq_period_service_fee','dfq_period_amount')")
        # ===== 0045_add_flow_direction_to_order_fields.py :: upgrade =====
    op.add_column('order_form_fields', sa.Column('flow_direction', sa.String(length=8), nullable=True))
    op.drop_column('order_form_fields', 'fund_nature')
    op.execute("UPDATE order_form_fields SET flow_direction = 'OUT' WHERE section = 'FINANCE' AND field_key IN ('recovery_price','th_purchase_amount','intermediary_fee','payment_pool_id','payment_recipient','payment_note')")
    op.execute("UPDATE order_form_fields SET flow_direction = 'IN' WHERE section = 'FINANCE' AND field_key IN ('th_receive_amount','amount','payment_method','pool_id','down_payment','service_fee','periods','per_period_service_fee','per_period')")
    op.execute("UPDATE order_form_fields SET flow_direction = 'OUT' WHERE section = 'FINANCE' AND field_key IN ('dfq_down_payment','dfq_service_fee','dfq_period_service_fee','dfq_period_amount')")
        # ===== 0046_limit_order_flow_direction_scope.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET flow_direction = NULL WHERE order_type_code NOT IN ('HS', 'TH', 'DFQ', 'SALE')")
        # ===== 0047_remove_payment_recipient_field.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET is_active = 0 WHERE field_key = 'payment_recipient'")
        # ===== 0048_add_base_flow_direction.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET flow_direction = 'BASE' WHERE order_type_code IN ('HS','TH','DFQ','SALE') AND section = 'FINANCE' AND field_key IN ('payment_pool_id','payment_note','payment_method','periods','dfq_periods','first_due_on')")
        # ===== 0049_delete_payment_recipient_fields.py :: upgrade =====
    op.execute("DELETE FROM order_form_fields WHERE field_key = 'payment_recipient'")
        # ===== 0050_set_order_cancel_incoming_flow.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET flow_direction = 'IN' WHERE order_type_code = 'ORDERCANC' AND field_key = 'cancel_amount'")
        # ===== 0051_add_list_column_configs.py :: upgrade =====
    op.create_table('list_column_configs', sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True), sa.Column('scope', sa.String(length=32), nullable=False), sa.Column('column_key', sa.String(length=64), nullable=False), sa.Column('is_visible', sa.Boolean(), nullable=False, server_default=sa.true()), sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'), sa.Column('created_by', sa.String(length=64), nullable=False, server_default='system'), sa.Column('updated_by', sa.String(length=64), nullable=False, server_default='system'), sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()), sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()), sa.UniqueConstraint('scope', 'column_key', name='uq_list_column_configs_scope_column'))
        # ===== 0052_add_list_column_width_fixed.py :: upgrade =====
    op.add_column('list_column_configs', sa.Column('width', sa.Integer(), nullable=True))
    op.add_column('list_column_configs', sa.Column('fixed', sa.String(length=8), nullable=True))
        # ===== 0053_add_list_custom_columns.py :: upgrade =====
    op.create_table('list_custom_columns', sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True), sa.Column('scope', sa.String(length=32), nullable=False), sa.Column('column_key', sa.String(length=80), nullable=False), sa.Column('label', sa.String(length=64), nullable=False), sa.Column('source_key', sa.String(length=64), nullable=False), sa.Column('field_type', sa.String(length=16), nullable=False, server_default='TEXT'), sa.Column('value_labels', sa.JSON(), nullable=True), sa.Column('created_by', sa.String(length=64), nullable=False, server_default='system'), sa.Column('updated_by', sa.String(length=64), nullable=False, server_default='system'), sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()), sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()), sa.UniqueConstraint('scope', 'column_key', name='uq_list_custom_columns_scope_column'))
        # ===== 0054_seed_allocation_form_fields.py :: upgrade =====
    session = Session(bind=op.get_bind())
    try:
        existing = {row.field_key for row in session.scalars(select(OrderFormField).where(OrderFormField.order_type_code == 'ALLOCATION'))}
        for field_key, label, field_type, required, sort_order in m54_SEED:
            if field_key in existing:
                continue
            session.add(OrderFormField(order_type_code='ALLOCATION', field_key=field_key, label=label, field_type=field_type, required=required, is_active=True, sort_order=sort_order, locked=True, is_custom=False, created_by='system', updated_by='system'))
        session.commit()
    finally:
        session.close()
        # ===== 0055_move_consignment_to_operation_section.py :: upgrade =====
    op.execute("UPDATE order_form_fields SET section = 'OPERATION' WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'")
        # ===== 0056_merge_distribution_installment_types.py :: upgrade =====
    op.execute(sa.text("UPDATE installments SET contract_type = 'STOCK_SALE' WHERE contract_type IN ('PICKUP_SALE', 'CONSIGNMENT_SALE')"))
        # ===== 0057_update_refund_cashflow_form_fields.py :: upgrade =====
    session = Session(bind=op.get_bind())
    try:
        rows = {row.field_key: row for row in session.scalars(select(OrderFormField).where(OrderFormField.order_type_code == 'REFUND'))}
        responsibility = rows.get('refund_responsibility')
        if responsibility is not None:
            responsibility.is_active = False
            responsibility.updated_by = 'system'
        amount = rows.get('amount')
        if amount is not None:
            amount.label = '金额'
            amount.section = 'FINANCE'
            amount.flow_direction = 'OUT'
        reason = rows.get('reason')
        if reason is not None:
            reason.label = '收支备注'
            reason.section = 'FINANCE'
        if 'occurred_on' not in rows:
            session.add(OrderFormField(order_type_code='REFUND', field_key='occurred_on', label='发生日期', field_type='DATE', required=True, is_active=True, sort_order=10, locked=True, is_custom=False, section='FINANCE', created_by='system', updated_by='system'))
        if 'direction' not in rows:
            session.add(OrderFormField(order_type_code='REFUND', field_key='direction', label='资金流向', field_type='SELECT', options=[{'value': 'OUT', 'label': '支出'}], required=True, is_active=True, sort_order=20, locked=True, is_custom=False, section='FINANCE', created_by='system', updated_by='system'))
        if amount is not None:
            amount.sort_order = 30
        if reason is not None:
            reason.sort_order = 40
        session.commit()
    finally:
        session.close()
        # ===== 0058_add_rebate_operator_user_ids.py :: upgrade =====
    op.add_column('rebate_records', sa.Column('operator_user_ids', sa.JSON(), nullable=True))
        # ===== 0059_remove_rebate_expected_on.py :: upgrade =====
    with op.batch_alter_table('rebate_records') as batch:
        batch.drop_index('ix_rebate_records_expected_status')
        batch.drop_column('expected_on')
        # ===== 0060_remove_rebate_settlement_history.py :: upgrade =====
    op.execute('\n        DELETE FROM cashflow\n        WHERE reversal_of_id IN (\n          SELECT cashflow_id FROM rebate_settlements WHERE cashflow_id IS NOT NULL\n          UNION\n          SELECT fee_cashflow_id FROM rebate_settlements WHERE fee_cashflow_id IS NOT NULL\n        )\n        ')
    op.execute('\n        DELETE FROM cashflow\n        WHERE id IN (\n          SELECT cashflow_id FROM rebate_settlements WHERE cashflow_id IS NOT NULL\n          UNION\n          SELECT fee_cashflow_id FROM rebate_settlements WHERE fee_cashflow_id IS NOT NULL\n        )\n        ')
    op.execute('DELETE FROM rebate_settlements')
        # ===== 0061_remove_orphan_rebate_cashflows.py :: upgrade =====
    op.execute("\n        DELETE FROM cashflow\n        WHERE category IN ('REBATE', 'REBATE_FEE', 'REBATE_REVERSAL', 'REBATE_FEE_REVERSAL')\n        ")
        # ===== 0062_normalize_rebate_status.py :: upgrade =====
    op.execute("UPDATE rebate_records SET status = 'SETTLED'")
        # ===== 0063_remove_legacy_rebate_configs.py :: upgrade =====
    op.execute("\n        DELETE FROM order_form_fields\n        WHERE order_type_code IN ('REBSETTLE', 'REBREVERSE', 'REBATEVOID')\n        ")
    op.execute("DELETE FROM option_sets WHERE code = 'REBATE_STATUS'")
        # ===== 0064_expand_buy_rebate_scope.py :: upgrade =====
    op.execute('\n        UPDATE option_sets\n        SET options = \'[{"value":"BUY","label":"买号返点（对应回收/提号/代分期）"},{"value":"SELL","label":"卖号返点（对应售出）"}]\',\n            description = \'返点类型：买号返点可关联回收、提号或代分期；卖号返点关联售出。\'\n        WHERE code = \'REBATE_TYPE\'\n        ')
        # ===== 0065_allow_split_cashflow_per_event.py :: upgrade =====
    with op.batch_alter_table('cashflow') as batch_op:
        batch_op.drop_constraint('uq_cashflow_event', type_='unique')
        # ===== 0066_add_order_form_section_labels.py :: upgrade =====
    op.create_table('order_form_section_labels', sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True), sa.Column('order_type_code', sa.String(length=16), nullable=False), sa.Column('section_key', sa.String(length=16), nullable=False), sa.Column('label', sa.String(length=128), nullable=False), sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()), sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()), sa.Column('created_by', sa.String(length=64), nullable=False, server_default='system'), sa.Column('updated_by', sa.String(length=64), nullable=False, server_default='system'), sa.UniqueConstraint('order_type_code', 'section_key', name='uq_order_form_section_labels_code_key'))
        # ===== 0067_drop_period_locks.py :: upgrade =====
    op.drop_table('period_locks')
        # ===== 0068_add_independent_inventory_status.py :: upgrade =====
    op.add_column('stocks', sa.Column('inventory_status', sa.String(length=16), nullable=False, server_default='IN_STOCK'))
    op.execute(sa.text("UPDATE stocks SET inventory_status = CASE WHEN status = 'IN_STOCK' THEN 'IN_STOCK' ELSE 'OUT_OF_STOCK' END"))
    with op.batch_alter_table('stocks') as batch_op:
        batch_op.create_check_constraint('account_inventory_status_valid', "inventory_status IN ('IN_STOCK', 'OUT_OF_STOCK')")
        # ===== 0069_split_order_installment_status.py :: upgrade =====
    op.execute(sa.text("UPDATE stocks SET status = 'SOLD' WHERE status = 'INSTALLMENT'"))
    with op.batch_alter_table('stocks', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_accounts_account_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_accounts_account_status_valid'), "status IN ('IN_STOCK', 'SOLD', 'VOID')")
    with op.batch_alter_table('orders', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_orders_order_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_orders_order_status_valid'), "status IN ('ACTIVE', 'INSTALLMENT', 'COMPLETED', 'CANCELLED')")
    op.execute(sa.text("UPDATE option_sets SET options = :options WHERE code = 'INVENTORY_STATUS'").bindparams(options='[{"value":"IN_STOCK","label":"在库"},{"value":"OUT_OF_STOCK","label":"出库"}]'))
    op.execute(sa.text("UPDATE option_sets SET options = :options WHERE code = 'ORDER_STATUS'").bindparams(options='[{"value":"ACTIVE","label":"进行中"},{"value":"INSTALLMENT","label":"分期中"},{"value":"COMPLETED","label":"已完成"},{"value":"CANCELLED","label":"已取消"}]'))
        # ===== 0070_hide_internal_installment_pending.py :: upgrade =====
    m70__set_options(m70__PUBLIC_INSTALLMENT_STATUS_OPTIONS)
        # ===== 0071_rename_account_waiting_status.py :: upgrade =====
    with op.batch_alter_table('stocks', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_accounts_account_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_accounts_account_status_valid'), "status IN ('IN_STOCK', 'WAITING', 'SOLD', 'VOID')")
    op.execute(sa.text("UPDATE stocks SET status = 'WAITING' WHERE status = 'IN_STOCK'"))
    with op.batch_alter_table('stocks', naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv('ck_accounts_account_status_valid'), type_='check')
        batch_op.create_check_constraint(conv('ck_accounts_account_status_valid'), "status IN ('WAITING', 'SOLD', 'VOID')")


def downgrade() -> None:
    # 压平迁移的 downgrade：本迁移在 0001 基线之上新增/变更了若干表与约束，
    # 而基线 0001 的 downgrade() 只 DROP 它自身创建的 37 张表，并不知晓本迁移
    # 新增的表（如 stocks / list_column_configs / list_custom_columns /
    # order_form_section_labels）。因此此处负责「全量拆除」——枚举当前库中所有
    # 用户表一并 DROP；随后 0001 的 downgrade() 仍以 DROP TABLE IF EXISTS 兜底
    # （已不存在，幂等 no-op）。两者串联后 `downgrade base` 得到仅含 alembic_version
    # 的空库，与升级前的初始态一致。
    # 注意：SQLite 的 DROP TABLE 不受外键约束限制，且使用 IF EXISTS，故任意顺序
    # 拆除均安全。生产环境不做回滚；此函数仅为 CI 往返测试与本地重置提供保障。
    bind = op.get_bind()
    table_names = [
        row[0]
        for row in bind.execute(
            sa.text(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        ).fetchall()
    ]
    for name in table_names:
        if name == "alembic_version":
            continue
        bind.exec_driver_sql(f'DROP TABLE IF EXISTS "{name}"')
