"""seed_pool_account_fields：资金池账户表单的「账户类型 / 归属」纳入配置体系

用户裁决把资金池账户设置表单的 account_type / ownership（B 类死枚举，后端有
CHECK 白名单）纳入配置化。本迁移在 order_form_fields 注册 POOLACCOUNT 作用域的
两条 SELECT 字段并回填 options（与界面现状一致）。

- account_type: BANK / CASH / THIRD_PARTY（pool_accounts.account_type CHECK）
- ownership:   OWNED / CUSTODY / THIRD_PART（PoolOwnership CHECK）

本迁移只插入数据，不改表结构；幂等：已存在 (order_type_code, field_key) 则跳过。

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-10-26 05:00:00.000000

"""

from __future__ import annotations

from typing import Sequence

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision: str = 'e5f6a7b8c9d0'
down_revision: str | None = 'd4e5f6a7b8c9'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# POOLACCOUNT 作用域的字段定义：(field_key, label, options, sort_order)
POOLACCOUNT_FIELDS: list[tuple[str, str, list[dict[str, str]], int]] = [
    (
        "account_type",
        "账户类型",
        [
            {"value": "BANK", "label": "银行账户"},
            {"value": "CASH", "label": "现金"},
            {"value": "THIRD_PARTY", "label": "第三方渠道"},
        ],
        0,
    ),
    (
        "ownership",
        "归属",
        [
            {"value": "OWNED", "label": "自有（计入权益）"},
            {"value": "CUSTODY", "label": "代管（只计头寸）"},
            {"value": "THIRD_PART", "label": "第三方（只计头寸）"},
        ],
        1,
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        existing = {
            (row.order_type_code, row.field_key)
            for row in session.scalars(select(OrderFormField)).all()
        }
        for field_key, label, options, sort_order in POOLACCOUNT_FIELDS:
            if ("POOLACCOUNT", field_key) in existing:
                continue
            session.add(
                OrderFormField(
                    order_type_code="POOLACCOUNT",
                    field_key=field_key,
                    label=label,
                    field_type="SELECT",
                    options=options,
                    required=True,
                    is_active=True,
                    locked=True,  # 预置死枚举字段，禁止删除（仍可改必填/停用/标签）
                    is_custom=False,
                    sort_order=sort_order,
                )
            )
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        rows = session.scalars(
            select(OrderFormField).where(OrderFormField.order_type_code == "POOLACCOUNT")
        ).all()
        for row in rows:
            session.delete(row)
        session.commit()
    finally:
        session.close()
