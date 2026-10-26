"""create_option_sets：D 类筛选器 / 业务字典的通用选项词典表 + 种子。

用户裁决「D 类筛选器配置化（纯字典可编辑 + 死枚举只读）」。本迁移建
`option_sets` 表（code 唯一、options 为 [{value,label}] JSON），并种子 7 个
当前页面筛选项典——均为后端死枚举（editable=False，只读展示）：

- 库存中心：库存状态 / 业务 / 类型
- 资金中心：流水方向 / 流水状态 / 资金性质 / 核算属性

本迁移建表 + 插数据；幂等：已存在相同 code 则跳过种子。

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-10-26 06:00:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet


revision: str = 'f6a7b8c9d0e1'
down_revision: str | None = 'e5f6a7b8c9d0'
branch_labels: str | None = None
depends_on: str | None = None

# code -> (label, group, options)
SEED: dict[str, tuple[str, str, list[dict[str, str]]]] = {
    "INVENTORY_STATUS": (
        "库存状态",
        "INVENTORY",
        [
            {"value": "IN_STOCK", "label": "在库"},
            {"value": "INSTALLMENT", "label": "分期中"},
            {"value": "SOLD", "label": "已售"},
            {"value": "VOID", "label": "下架"},
        ],
    ),
    "INVENTORY_BUSINESS": (
        "库存业务",
        "INVENTORY",
        [
            {"value": "SELF", "label": "自营"},
            {"value": "DISTRIBUTION", "label": "分销"},
        ],
    ),
    "INVENTORY_TYPE": (
        "库存类型",
        "INVENTORY",
        [
            {"value": "RECOVERY", "label": "回收"},
            {"value": "PICKUP", "label": "提号"},
            {"value": "CONSIGNMENT", "label": "代挂"},
        ],
    ),
    "FUND_FLOW_DIRECTION": (
        "流水方向",
        "FUND",
        [
            {"value": "IN", "label": "收入"},
            {"value": "OUT", "label": "支出"},
        ],
    ),
    "FUND_FLOW_STATUS": (
        "流水状态",
        "FUND",
        [
            {"value": "PENDING", "label": "待审核"},
            {"value": "APPROVED", "label": "已审核"},
            {"value": "REJECTED", "label": "已拒绝"},
        ],
    ),
    "FUND_FLOW_FUND_NATURE": (
        "流水资金性质",
        "FUND",
        [
            {"value": "BUSINESS", "label": "本方经营"},
            {"value": "EXTERNAL", "label": "外部/受托"},
            {"value": "INTERNAL", "label": "内部调拨"},
        ],
    ),
    "FUND_FLOW_ACCOUNTING_ATTRIBUTE": (
        "流水核算属性",
        "FUND",
        [
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
    ),
}


def upgrade() -> None:
    op.create_table(
        "option_sets",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("group", sa.String(length=64), nullable=False, server_default="GENERAL"),
        sa.Column("editable", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("options", sa.JSON(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.Column("updated_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index("ix_option_sets_group", "option_sets", ["group"], unique=False)

    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        existing = set(session.scalars(select(OptionSet.code)).all())
        for code, (label, group, options) in SEED.items():
            if code in existing:
                continue
            session.add(
                OptionSet(
                    code=code,
                    label=label,
                    group=group,
                    editable=False,
                    options=options,
                    description="后端死枚举，只读；值受后端 CHECK 约束",
                )
            )
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        for code in SEED:
            row = session.scalars(select(OptionSet).where(OptionSet.code == code)).first()
            if row is not None:
                session.delete(row)
        session.commit()
    finally:
        session.close()

    op.drop_index("ix_option_sets_group", table_name="option_sets")
    op.drop_table("option_sets")
