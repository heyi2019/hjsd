"""order_form_fields：建单表单字段配置 + orders.form_extra

Revision ID: a1b2c3d4e5f6
Revises: 0001
Create Date: 2026-10-25 12:30:00.000000

"""
from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import Amount
from app.domain.trade import OrderFormField


revision: str = 'a1b2c3d4e5f6'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 默认字段清单：per 业务类型 code。
# 元组：(field_key, label, field_type, required, locked, sort_order)
# 既有硬编码字段在配置里只用于「覆盖必填/显示/排序/标签」，field_type 仅对自定义字段生效。
_ACCOUNT_FIELDS = [
    ("game_type", "游戏类型", "SELECT", True, True, 10),
    ("game_account", "游戏账号", "TEXT", True, True, 20),
    ("game_password", "账号密码", "TEXT", True, True, 30),
    ("channel_region", "渠道／区服", "TEXT", True, True, 40),
    ("bound_phone", "绑定手机号", "TEXT", False, False, 50),
    ("has_secondary", "有无二次", "SELECT", False, False, 60),
    ("game_account_note", "账号备注", "TEXT", False, False, 70),
]
_FEE_AND_PAYMENT = [
    ("intermediary_fee", "中介费", "NUMBER", False, False, 810),
    ("intermediary_platform", "经手平台", "SELECT", False, False, 820),
    ("intermediary_type", "中介类型", "SELECT", False, False, 830),
    ("compensation_type", "包赔类型", "SELECT", False, False, 840),
    ("other_fee_name", "其他", "TEXT", False, False, 850),
    ("other_fee_amount", "金额", "NUMBER", False, False, 860),
    ("other_fee_recipient", "收款对象", "TEXT", False, False, 870),
    ("design_fee", "设计费", "NUMBER", False, False, 880),
    ("payment_pool_id", "付款资金账户", "SELECT", True, True, 910),
    ("payment_recipient", "付款对象", "TEXT", False, False, 920),
    ("payment_note", "资金流水备注", "TEXT", False, False, 930),
]

# 种子 label 必须与现有表单 UI 文案完全一致：开启配置能力后默认不改动任何展示，
# 用户后续在设置中改 label 才会生效。required 也必须与表单当前必填态一致，避免开启即强制必填。
SEED: dict[str, list[tuple[str, str, str, bool, bool, int]]] = {
    "HS": _ACCOUNT_FIELDS + [
        ("customer_nickname", "客户昵称", "TEXT", True, True, 110),
        ("customer_source", "客户来源", "SELECT", True, True, 120),
        ("customer_source_other", "其他来源", "TEXT", False, False, 130),
        ("customer_contact_name", "姓名", "TEXT", False, False, 140),
        ("customer_phone", "手机号", "TEXT", False, False, 150),
        ("customer_wechat", "微信号", "TEXT", False, False, 160),
        ("customer_qq", "QQ", "TEXT", False, False, 170),
        ("note", "客户备注", "TEXT", False, False, 180),
        ("recovery_price", "账号号价", "NUMBER", True, True, 710),
    ] + _FEE_AND_PAYMENT,
    "TH": _ACCOUNT_FIELDS + [
        ("th_purchase_amount", "账号号价", "NUMBER", True, True, 110),
        ("th_receive_amount", "预计收买家", "NUMBER", True, True, 120),
        ("supplier_nickname", "供货方昵称", "TEXT", True, True, 210),
        ("supplier_source", "供货方来源", "SELECT", True, True, 220),
        ("supplier_source_other", "其他来源", "TEXT", False, False, 230),
        ("supplier_contact_name", "公司名", "TEXT", False, False, 240),
        ("supplier_phone", "手机号", "TEXT", False, False, 250),
        ("supplier_wechat", "微信号", "TEXT", False, False, 260),
        ("supplier_qq", "QQ", "TEXT", False, False, 270),
        ("supplier_note", "供货方备注", "TEXT", False, False, 280),
    ] + _FEE_AND_PAYMENT,
    "DG": _ACCOUNT_FIELDS + [
        ("dg_customer_nickname", "客户昵称", "TEXT", True, True, 110),
        ("dg_customer_source", "客户来源", "SELECT", True, True, 120),
        ("dg_customer_source_other", "其他来源", "TEXT", False, False, 130),
        ("dg_customer_contact", "姓名", "TEXT", False, False, 140),
        ("dg_customer_phone", "手机号", "TEXT", False, False, 150),
        ("dg_customer_qq", "QQ", "TEXT", False, False, 160),
        ("dg_customer_wechat", "微信号", "TEXT", False, False, 170),
        ("dg_note", "代挂备注", "TEXT", False, False, 180),
    ],
    "DFQ": [
        ("dfq_game_type", "游戏类型", "SELECT", True, True, 10),
        ("dfq_game_account", "游戏账号", "TEXT", True, True, 20),
        ("dfq_game_password", "账号密码", "TEXT", True, True, 30),
        ("dfq_channel_region", "渠道／区服", "TEXT", True, True, 40),
        ("dfq_bound_phone", "绑定手机号", "TEXT", False, False, 50),
        ("dfq_has_secondary", "有无二次", "SELECT", False, False, 60),
        ("dfq_game_account_note", "账号备注", "TEXT", False, False, 70),
        ("dfq_purchase_price", "账号号价", "NUMBER", True, True, 110),
        ("dfq_down_payment", "客户首付款", "NUMBER", False, False, 120),
        ("dfq_service_fee", "手续费总额", "NUMBER", False, False, 130),
        ("dfq_periods", "分期期数", "NUMBER", False, True, 140),
        ("dfq_period_service_fee", "每期手续费", "NUMBER", False, False, 150),
        ("dfq_period_amount", "每期金额", "NUMBER", False, False, 160),
        ("dfq_payment_pool_id", "付款资金账户", "SELECT", True, True, 910),
        ("dfq_payment_recipient", "付款对象", "TEXT", False, False, 920),
        ("dfq_payment_note", "资金流水备注", "TEXT", False, False, 930),
        ("dfq_customer_nickname", "客户昵称", "TEXT", True, True, 210),
        ("dfq_customer_source", "客户来源", "SELECT", True, True, 220),
        ("dfq_customer_contact", "联系方式", "TEXT", False, False, 230),
        ("dfq_customer_phone", "手机号", "TEXT", False, False, 240),
        ("dfq_customer_qq", "QQ", "TEXT", False, False, 250),
        ("dfq_customer_wechat", "微信号", "TEXT", False, False, 260),
        ("dfq_note", "分期备注", "TEXT", False, False, 270),
    ],
}


def upgrade() -> None:
    op.create_table(
        'order_form_fields',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('order_type_code', sa.String(length=16), nullable=False),
        sa.Column('field_key', sa.String(length=64), nullable=False),
        sa.Column('label', sa.String(length=128), nullable=False),
        sa.Column('field_type', sa.String(length=16), nullable=False, server_default='TEXT'),
        sa.Column('options', sa.JSON(), nullable=True),
        sa.Column('required', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('1')),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('locked', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('is_custom', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_by', sa.String(length=64), nullable=False, server_default='system'),
        sa.Column('updated_by', sa.String(length=64), nullable=False, server_default='system'),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.CheckConstraint(
            "field_type IN ('TEXT','NUMBER','DATE','BOOLEAN','SELECT','MULTI_SELECT')",
            name=op.f('ck_order_form_fields_field_type_valid'),
        ),
        sa.UniqueConstraint('order_type_code', 'field_key', name='uq_order_form_fields_code_key'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_order_form_fields')),
    )
    with op.batch_alter_table('order_form_fields', schema=None) as batch_op:
        batch_op.create_index('ix_order_form_fields_code_sort', ['order_type_code', 'sort_order'], unique=False)

    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.add_column(sa.Column('form_extra', sa.JSON(), nullable=True))

    # 幂等种子：仅在表为空时写入四表单默认字段。
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        if not session.scalar(select(func.count()).select_from(OrderFormField)):
            rows = []
            for code, fields in SEED.items():
                for sort, (key, label, ftype, required, locked, order) in enumerate(fields):
                    rows.append(
                        OrderFormField(
                            order_type_code=code,
                            field_key=key,
                            label=label,
                            field_type=ftype,
                            required=required,
                            is_active=True,
                            sort_order=order,
                            locked=locked,
                            created_by="system",
                            updated_by="system",
                        )
                    )
            session.add_all(rows)
            session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        session.query(OrderFormField).delete()
        session.commit()
    finally:
        session.close()
    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.drop_column('form_extra')
    op.drop_table('order_form_fields')
