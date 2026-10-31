"""0003 资金流水按方向独立编号 + 编号域词典更名 + 序列位数上限放宽。

口径（2026-10-28 用户裁决）：
- 资金流水不再共用 CF+四位流水：支出独立 ZC+五位流水（ZC00001）、
  收入独立 SR+五位流水（SR00001）；document_sequences 删除 CASHFLOW（CF）域，
  新增 CASHFLOW_OUT / CASHFLOW_IN。存量 CF 流水与订单从属号
  （HS0001-CF-SELL-01 等）保留原号不改写。
- 序列位数上限放宽：padding<=4 → padding<=6、current_value<=9999 → <=999999
  （SQLite 改 CHECK 走「建新表→拷→删→改名」重建）；
  发放上限定为 10^padding-1，见 core.numbering.allocate_number。
- 编号域词典（SEQUENCE_KEY）同步终稿：分期订单（INSTALLMENT/FQ，关联业务类型）、
  代分期订单（ORDER_DFQ，不关联业务类型）、支出流水 / 收入流水。
"""
from __future__ import annotations

import json

from alembic import op
from sqlalchemy import text

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

# 表 DDL 模板：{padding_max} / {value_max} 为放宽前后的 CHECK 阈值 token。
_DDL_TEMPLATE = (
    'CREATE TABLE {name} (\n'
    '\tid INTEGER NOT NULL, \n'
    '\tsequence_key VARCHAR(64) NOT NULL, \n'
    '\tprefix VARCHAR(16) NOT NULL, \n'
    '\tpadding INTEGER NOT NULL, \n'
    '\tcurrent_value INTEGER NOT NULL, \n'
    '\tcreated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, \n'
    '\tupdated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, \n'
    '\tCONSTRAINT pk_document_sequences PRIMARY KEY (id), \n'
    '\tCONSTRAINT uq_document_sequences_key UNIQUE (sequence_key), \n'
    '\tCONSTRAINT ck_document_sequences_padding_positive CHECK (padding > 0), \n'
    '\tCONSTRAINT ck_document_sequences_current_value_nonneg CHECK (current_value >= 0), \n'
    '\tCONSTRAINT ck_document_sequences_padding_max CHECK (padding <= {padding_max}), \n'
    '\tCONSTRAINT ck_document_sequences_current_value_max CHECK (current_value <= {value_max}), \n'
    '\tCONSTRAINT ck_document_sequences_sequence_key_nonempty CHECK (length(trim(sequence_key)) > 0), \n'
    '\tCONSTRAINT ck_document_sequences_prefix_nonempty CHECK (length(trim(prefix)) > 0)\n'
    ')'
)

# 终稿词典：CASHFLOW 拆分为支出/收入，分期/代分期更名「xx订单」。
_SEQ_OPTIONS_NEW = json.dumps(
    [
        {"value": "ORDER_HS", "label": "回收编号"},
        {"value": "ORDER_TH", "label": "提号编号"},
        {"value": "ORDER_DG", "label": "代挂编号"},
        {"value": "ORDER_DFQ", "label": "代分期订单"},
        {"value": "INSTALLMENT", "label": "分期订单"},
        {"value": "CASHFLOW_OUT", "label": "支出流水"},
        {"value": "CASHFLOW_IN", "label": "收入流水"},
        {"value": "CUSTOMER", "label": "客户"},
        {"value": "COUNTERPARTY", "label": "合作方"},
        {"value": "LEAD", "label": "需求"},
        {"value": "QUALITY_ISSUE", "label": "质量工单"},
        {"value": "NOTIFICATION", "label": "通知"},
        {"value": "IMPORT", "label": "导入批次"},
        {"value": "ATTACHMENT", "label": "附件"},
    ],
    ensure_ascii=False,
)
_SEQ_OPTIONS_OLD = json.dumps(
    [
        {"value": "ORDER_HS", "label": "回收编号"},
        {"value": "ORDER_TH", "label": "提号编号"},
        {"value": "ORDER_DG", "label": "代挂编号"},
        {"value": "ORDER_DFQ", "label": "代分期编号"},
        {"value": "INSTALLMENT", "label": "分期编号"},
        {"value": "CASHFLOW", "label": "资金流水"},
        {"value": "CUSTOMER", "label": "客户"},
        {"value": "COUNTERPARTY", "label": "合作方"},
        {"value": "LEAD", "label": "需求"},
        {"value": "QUALITY_ISSUE", "label": "质量工单"},
        {"value": "NOTIFICATION", "label": "通知"},
        {"value": "IMPORT", "label": "导入批次"},
        {"value": "ATTACHMENT", "label": "附件"},
    ],
    ensure_ascii=False,
)


def _rebuild_table(padding_max: int, value_max: int) -> None:
    """按「建新表→拷→删→改名」重建 document_sequences（SQLite 不支持改 CHECK）。"""
    bind = op.get_bind()
    bind.execute(text(_DDL_TEMPLATE.format(name="document_sequences_new", padding_max=padding_max, value_max=value_max)))
    bind.execute(
        text(
            "INSERT INTO document_sequences_new "
            "(id, sequence_key, prefix, padding, current_value, created_at, updated_at) "
            "SELECT id, sequence_key, prefix, padding, current_value, created_at, updated_at "
            "FROM document_sequences"
        )
    )
    bind.execute(text("DROP TABLE document_sequences"))
    bind.execute(text("ALTER TABLE document_sequences_new RENAME TO document_sequences"))


def upgrade() -> None:
    bind = op.get_bind()
    # 1. 放宽序列位数上限（4 位 → 6 位，容纳五位流水）。
    _rebuild_table(padding_max=6, value_max=999999)
    # 2. 编号序列：支出 ZC+五位、收入 SR+五位；退役 CF 共用域。
    bind.execute(
        text(
            "INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) "
            "VALUES ('CASHFLOW_OUT', 'ZC', 5, 0), ('CASHFLOW_IN', 'SR', 5, 0)"
        )
    )
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key = 'CASHFLOW'"))
    # 3. 编号域词典同步终稿。
    bind.execute(
        text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"),
        {"options": _SEQ_OPTIONS_NEW},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DELETE FROM document_sequences WHERE sequence_key IN ('CASHFLOW_OUT', 'CASHFLOW_IN')"))
    bind.execute(
        text(
            "INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) "
            "VALUES ('CASHFLOW', 'CF', 4, 0)"
        )
    )
    bind.execute(
        text("UPDATE option_sets SET options = :options WHERE code = 'SEQUENCE_KEY'"),
        {"options": _SEQ_OPTIONS_OLD},
    )
    _rebuild_table(padding_max=4, value_max=9999)

