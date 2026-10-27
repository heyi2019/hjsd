"""seed_select_options：回填建单表单所有下拉字段的可选项

0003 已登记 43 个下拉字段（SELECT 41 + MULTI_SELECT 2），但 options 列全为 NULL，
导致设置页「选项」显示为空、且各弹窗下拉仍用前端硬编码数组。本迁移把每类下拉的
当前可选项（取自各弹窗现有的硬编码字典/枚举，与界面现状一致）回填进 options 列。

选项分两类：
- 纯字典（value=label 可自行增删）：有无二次 / 客户来源 / 供货方来源 / 经手平台 /
  中介类型 / 包赔类型 / 需求类型 / 付款方式
- 后端死枚举（value 为英文码，受 CHECK 白名单约束，只能改 label 不能加值）：收支方向 /
  资金性质 / 核算属性 / 返点类型 / 交付方式

本迁移只回填数据，不改表结构；幂等：已非空的不覆盖。

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-10-26 04:30:00.000000

"""
from __future__ import annotations

from typing import Sequence

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision: str = 'd4e5f6a7b8c9'
down_revision: str | None = 'c3d4e5f6a7b8'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (order_type_code, field_key) -> 选项列表 [{value,label}]
# 纯字典：value=label
SEED_OPTIONS: dict[tuple[str, str], list[dict[str, str]]] = {
    # ---- 有无二次 ----
    ("HS", "has_secondary"): [{"value": "有", "label": "有"}, {"value": "无", "label": "无"}],
    ("DG", "has_secondary"): [{"value": "有", "label": "有"}, {"value": "无", "label": "无"}],
    ("DFQ", "dfq_has_secondary"): [{"value": "有", "label": "有"}, {"value": "无", "label": "无"}],
    ("TH", "has_secondary"): [{"value": "有", "label": "有"}, {"value": "无", "label": "无"}],
    # ---- 客户来源 ----
    ("DFQ", "dfq_customer_source"): [
        {"value": "自营", "label": "自营"},
        {"value": "微博", "label": "微博"},
        {"value": "小红书", "label": "小红书"},
        {"value": "闲鱼", "label": "闲鱼"},
        {"value": "同行推荐", "label": "同行推荐"},
        {"value": "其他", "label": "其他"},
    ],
    ("DG", "dg_customer_source"): [
        {"value": "自营", "label": "自营"},
        {"value": "微博", "label": "微博"},
        {"value": "小红书", "label": "小红书"},
        {"value": "闲鱼", "label": "闲鱼"},
        {"value": "同行推荐", "label": "同行推荐"},
        {"value": "其他", "label": "其他"},
    ],
    ("HS", "customer_source"): [
        {"value": "自营", "label": "自营"},
        {"value": "微博", "label": "微博"},
        {"value": "小红书", "label": "小红书"},
        {"value": "闲鱼", "label": "闲鱼"},
        {"value": "同行推荐", "label": "同行推荐"},
        {"value": "其他", "label": "其他"},
    ],
    ("TH", "customer_source"): [
        {"value": "自营", "label": "自营"},
        {"value": "微博", "label": "微博"},
        {"value": "小红书", "label": "小红书"},
        {"value": "闲鱼", "label": "闲鱼"},
        {"value": "同行推荐", "label": "同行推荐"},
        {"value": "其他", "label": "其他"},
    ],
    # ---- 供货方来源（TH）----
    ("TH", "supplier_source"): [
        {"value": "氪金联盟", "label": "氪金联盟"},
        {"value": "同行", "label": "同行"},
        {"value": "其他", "label": "其他"},
    ],
    # ---- 经手平台（HS/TH）----
    ("HS", "intermediary_platform"): [
        {"value": "盼之", "label": "盼之"},
        {"value": "千寻", "label": "千寻"},
        {"value": "白情", "label": "白情"},
        {"value": "螃蟹", "label": "螃蟹"},
        {"value": "私下", "label": "私下"},
        {"value": "其他", "label": "其他"},
    ],
    ("TH", "intermediary_platform"): [
        {"value": "盼之", "label": "盼之"},
        {"value": "千寻", "label": "千寻"},
        {"value": "白情", "label": "白情"},
        {"value": "螃蟹", "label": "螃蟹"},
        {"value": "私下", "label": "私下"},
        {"value": "其他", "label": "其他"},
    ],
    # ---- 中介类型（HS/TH）----
    ("HS", "intermediary_type"): [
        {"value": "普中", "label": "普中"},
        {"value": "包赔", "label": "包赔"},
    ],
    ("TH", "intermediary_type"): [
        {"value": "普中", "label": "普中"},
        {"value": "包赔", "label": "包赔"},
    ],
    # ---- 包赔类型（HS/TH）----
    ("HS", "compensation_type"): [
        {"value": "首保", "label": "首保"},
        {"value": "续保", "label": "续保"},
    ],
    ("TH", "compensation_type"): [
        {"value": "首保", "label": "首保"},
        {"value": "续保", "label": "续保"},
    ],
    # ---- 需求类型（LEAD）----
    ("LEAD", "request_type"): [
        {"value": "FIND_ACCOUNT", "label": "找号"},
        {"value": "SELL_ACCOUNT", "label": "卖号"},
        {"value": "SPECIFIC_SEARCH", "label": "指定搜索"},
    ],
    # ---- 付款方式（SALE，后端无枚举约束）----
    ("SALE", "payment_method"): [
        {"value": "FULL", "label": "全款"},
        {"value": "INSTALLMENT", "label": "分期付款"},
    ],
    # ---- 死枚举：收支方向（FUNDFLOW）----
    ("FUNDFLOW", "direction"): [
        {"value": "IN", "label": "收入"},
        {"value": "OUT", "label": "支出"},
    ],
    # ---- 死枚举：资金性质（FUNDFLOW）----
    ("FUNDFLOW", "fund_nature"): [
        {"value": "BUSINESS", "label": "本方经营"},
        {"value": "EXTERNAL", "label": "外部/受托"},
        {"value": "INTERNAL", "label": "内部调拨"},
    ],
    # ---- 死枚举：核算属性（FUNDFLOW，13 值）----
    ("FUNDFLOW", "accounting_attribute"): [
        {"value": "SELF_REVENUE", "label": "自营收入"},
        {"value": "SELF_DIRECT_COST", "label": "自营直接成本"},
        {"value": "TH_DIRECT_COST", "label": "提号/代挂直接成本"},
        {"value": "TH_REVENUE", "label": "提号/代挂收入"},
        {"value": "DFQ_PRINCIPAL", "label": "代分期借款本金"},
        {"value": "SERVICE_REVENUE", "label": "增值服务收入"},
        {"value": "REBATE_INCOME", "label": "返点收入"},
        {"value": "OPERATING_EXPENSE", "label": "运营费用"},
        {"value": "DEPOSIT", "label": "押金/保证金"},
        {"value": "EXTERNAL_FUNDING", "label": "外部资金"},
        {"value": "INTERNAL_TRANSFER", "label": "内部调拨"},
        {"value": "REVERSAL", "label": "冲销"},
        {"value": "REFUND", "label": "退款"},
    ],
    # ---- 死枚举：返点类型（REBATE / INVREBATE）----
    ("REBATE", "rebate_type"): [
        {"value": "BUY", "label": "买号返点"},
        {"value": "SELL", "label": "卖号返点"},
    ],
    ("INVREBATE", "rebate_type"): [
        {"value": "BUY", "label": "买号返点"},
        {"value": "SELL", "label": "卖号返点"},
    ],
    # ---- 死枚举：交付方式（INSTDELIVER）----
    ("INSTDELIVER", "delivery_mode"): [
        {"value": "PLATFORM_OPERATOR", "label": "平台/本方操作换绑"},
        {"value": "CUSTOMER_SELF", "label": "客户自行换绑"},
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        rows = session.scalars(select(OrderFormField)).all()
        for row in rows:
            key = (row.order_type_code, row.field_key)
            seed = SEED_OPTIONS.get(key)
            if not seed:
                continue
            # 幂等：已非空则跳过
            if row.options:
                continue
            row.options = seed
            session.add(row)
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        rows = session.scalars(select(OrderFormField)).all()
        for row in rows:
            key = (row.order_type_code, row.field_key)
            if key in SEED_OPTIONS:
                row.options = None
                session.add(row)
        session.commit()
    finally:
        session.close()
