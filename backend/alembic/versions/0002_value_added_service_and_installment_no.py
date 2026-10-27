"""0002 增值服务维度 + 分期独立单号 + 代分期账号入库回填。

口径（2026-10-28 用户裁决）：
- 业务类型保持三值（RECOVERY/PICKUP/CONSIGNMENT）；accounts 新增
  `value_added_service` 增值服务维度：STOCK_SALE=分期/
  ADVANCE_PURCHASE=代分期。
- 代分期垫资买入账号计入本方库存：业务归属=分销、业务类型留空、
  增值服务=ADVANCE_PURCHASE；存量 DFQ 订单按 account_snapshot 回填建账。
- 分期合约独立单号：新增编号序列 INSTALLMENT（前缀 FQ）；
  代分期合约沿用 DFQ 订单号衍生（DFQ0001-INS01）。
- 选项词典：INVENTORY_TYPE 更名「业务类型」；新增 VALUE_ADDED_SERVICE「增值服务」。
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

_VAS_OPTIONS = json.dumps(
    [
        {"value": "STOCK_SALE", "label": "分期"},
        {"value": "ADVANCE_PURCHASE", "label": "代分期"},
    ],
    ensure_ascii=False,
)

# 编号域词典（SEQUENCE_KEY）：2026-10-28 用户口径——订单域改名「xx编号」，
# 分期订单（INSTALLMENT/FQ，关联业务类型）与代分期订单（DFQ，不关联业务类型）；
# 0003 再统一「xx订单」命名并拆分资金流水，此处保持当时的「xx编号」口径不动。
_SEQ_KEYS_COMMON = [
    ("CUSTOMER", "客户"),
    ("COUNTERPARTY", "合作方"),
    ("LEAD", "需求"),
    ("QUALITY_ISSUE", "质量工单"),
    ("NOTIFICATION", "通知"),
    ("CASHFLOW", "资金流水"),
    ("IMPORT", "导入批次"),
    ("ATTACHMENT", "附件"),
]
_SEQ_OPTIONS_NEW = json.dumps(
    [
        {"value": "ORDER_HS", "label": "回收编号"},
        {"value": "ORDER_TH", "label": "提号编号"},
        {"value": "ORDER_DG", "label": "代挂编号"},
        {"value": "ORDER_DFQ", "label": "代分期编号"},
        {"value": "INSTALLMENT", "label": "分期编号"},
        *[{"value": value, "label": label} for value, label in _SEQ_KEYS_COMMON],
    ],
    ensure_ascii=False,
)
_SEQ_OPTIONS_OLD = json.dumps(
    [
        {"value": "ORDER_HS", "label": "回收订单"},
        {"value": "ORDER_TH", "label": "提号订单"},
        {"value": "ORDER_DG", "label": "代挂订单"},
        {"value": "ORDER_DFQ", "label": "代分期订单"},
        *[{"value": value, "label": label} for value, label in _SEQ_KEYS_COMMON],
    ],
    ensure_ascii=False,
)

# 存量 DFQ 订单回填：快照含 game_account 且尚未挂账号的，建账并回写 account_id。
# 同名账号已存在（UNIQUE game_account）的订单跳过，保持快照形式，不阻断迁移。
_BACKFILL_ACCOUNTS = """
INSERT INTO accounts (
    game_type, business_mode, inventory_type, value_added_service, game_account,
    game_password, channel_region, bound_phone, has_secondary, platform, status,
    cost_amount, note, created_by, updated_by
)
SELECT
    json_extract(o.account_snapshot, '$.game_type'),
    'DISTRIBUTION',
    NULL,
    'ADVANCE_PURCHASE',
    json_extract(o.account_snapshot, '$.game_account'),
    json_extract(o.account_snapshot, '$.game_password'),
    json_extract(o.account_snapshot, '$.channel_region'),
    json_extract(o.account_snapshot, '$.bound_phone'),
    json_extract(o.account_snapshot, '$.has_secondary'),
    json_extract(o.account_snapshot, '$.platform'),
    'IN_STOCK',
    0,
    '代分期垫资账号入库回填（迁移 0002，来源订单 ' || o.order_no || '）',
    'migration',
    'migration'
FROM orders o
WHERE o.order_type = 'DFQ'
  AND o.account_id IS NULL
  AND o.account_snapshot IS NOT NULL
  AND json_extract(o.account_snapshot, '$.game_account') IS NOT NULL
  AND json_extract(o.account_snapshot, '$.game_account') != ''
  AND NOT EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.game_account = json_extract(o.account_snapshot, '$.game_account')
  )
"""

_BACKFILL_ORDER_LINK = """
UPDATE orders
SET account_id = (
    SELECT a.id FROM accounts a
    WHERE a.game_account = json_extract(orders.account_snapshot, '$.game_account')
      AND a.value_added_service = 'ADVANCE_PURCHASE'
      AND a.created_by = 'migration'
)
WHERE order_type = 'DFQ'
  AND account_id IS NULL
  AND account_snapshot IS NOT NULL
  AND json_extract(account_snapshot, '$.game_account') IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.game_account = json_extract(orders.account_snapshot, '$.game_account')
        AND a.value_added_service = 'ADVANCE_PURCHASE'
        AND a.created_by = 'migration'
  )
"""


def upgrade() -> None:
    bind = op.get_bind()
    op.add_column(
        "accounts",
        sa.Column("value_added_service", sa.String(32), nullable=True),
    )
    # 编号序列：分期合约独立单号 FQ。
    bind.execute(
        text(
            "INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) "
            "VALUES ('INSTALLMENT', 'FQ', 4, 0)"
        )
    )
    # 编号域词典同步：订单域改名「xx编号」+ 追加分期编号（INSTALLMENT/FQ），
    # 编号序列页与用户口径一致（回收/提号/代挂/分期/代分期编号）。
    bind.execute(
        text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"),
        {"options": _SEQ_OPTIONS_NEW},
    )
    # 选项词典：业务类型更名 + 增值服务新组。
    bind.execute(text("UPDATE option_sets SET label = '业务类型' WHERE code = 'INVENTORY_TYPE'"))
    bind.execute(
        text(
            "INSERT INTO option_sets (code, label, \"group\", editable, options, description, created_by, updated_by) "
            "VALUES ('VALUE_ADDED_SERVICE', '增值服务', 'INVENTORY', 0, :options, "
            "'后端服务层校验取值，只读；STOCK_SALE=分期/ADVANCE_PURCHASE=代分期', 'system', 'system')"
        ),
        {"options": _VAS_OPTIONS},
    )
    # 存量代分期订单回填建账。
    bind.execute(text(_BACKFILL_ACCOUNTS))
    bind.execute(text(_BACKFILL_ORDER_LINK))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DELETE FROM option_sets WHERE code = 'VALUE_ADDED_SERVICE'"))
    bind.execute(text("UPDATE option_sets SET label = '库存类型' WHERE code = 'INVENTORY_TYPE'"))
    bind.execute(
        text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"),
        {"options": _SEQ_OPTIONS_OLD},
    )
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key = 'INSTALLMENT'"))
    # 回填建的账号保留（无归属引用时无害），仅回退结构与词典。
    op.drop_column("accounts", "value_added_service")
