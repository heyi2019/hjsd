"""form_extra columns + operation scope seeds

两件事：
1. 给 order_events / order_links / installments / accounts / cashflow 五张表
   增加 form_extra JSON 列（SQLite 允许 ADD COLUMN，幂等：先 PRAGMA 检查）。
   表单字段配置体系的自定义字段值统一落 form_extra（与 Order.form_extra /
   Customer.form_extra 同构）。
2. 为 12 个「操作类表单」作用域补充字段配置种子：订单操作 5（取消/编辑/关联/
   分润/退款）、库存操作 4（退款登记/下架/分期终止/账号编辑）、工作室 3
   （收支登记/拒绝/冲销）。清单与 app/orders/form_scopes.py 注册表一致。

种子 label 与 required 必须与各表单当前 UI 完全一致，保证开启配置能力后零行为
变化；用户后续在设置中改 label / required / is_active 才生效。

Revision ID: f7a8b9c0d1e2
Revises: c0d83a5e4f10
Create Date: 2026-10-27 01:00:00.000000

"""
from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision: str = 'f7a8b9c0d1e2'
down_revision: str | None = 'c0d83a5e4f10'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 需要新增 form_extra 列的表（JSON, nullable）。
FORM_EXTRA_TABLES = (
    "order_events",
    "order_links",
    "installments",
    "accounts",
    "cashflow",
)

# 元组：(field_key, label, field_type, required, sort_order)
SEED: dict[str, list[tuple[str, str, str, bool, int]]] = {
    # ---- 订单操作 ----
    "ORDERCANC": [
        ("offset_event_id", "被冲销动作", "SELECT", True, 10),
        ("cancel_amount", "冲销金额", "NUMBER", True, 20),
        ("cancelled_on", "取消日期", "DATE", True, 30),
        ("reason", "取消原因", "TEXT", True, 40),
    ],
    "ORDEREDIT": [
        ("trade_date", "成交日期", "DATE", False, 10),
        ("note", "备注", "TEXT", False, 20),
        ("snap_game_account", "账号标识", "TEXT", True, 30),
        ("snap_game_type", "产品", "TEXT", False, 40),
        ("snap_game_password", "账号密码", "TEXT", False, 50),
        ("snap_channel_region", "区服", "TEXT", False, 60),
        ("snap_bound_phone", "绑定手机", "TEXT", False, 70),
        ("snap_platform", "平台", "TEXT", False, 80),
        ("snap_purchase_price", "号价", "NUMBER", False, 90),
        ("snap_note", "快照备注", "TEXT", False, 100),
    ],
    "ORDERLINK": [
        ("related_order_id", "关联订单", "SELECT", True, 10),
        ("relation_type", "关系", "SELECT", True, 20),
        ("split_ratio", "分成比例（%）", "TEXT", False, 30),
        ("split_amount", "分成金额（元）", "TEXT", False, 40),
        ("note", "备注", "TEXT", False, 50),
    ],
    # ALLOCATION（订单分润）与 INVEDIT（编辑账号及执行明细）的核心字段
    # 为行内/受控硬编码 UI，配置暂不驱动，故不播种（避免「配了不生效」）；
    # 这两个作用域仅承载自定义字段（form_extra）。
    "REFUND": [
        ("amount", "退款金额", "NUMBER", True, 10),
        ("refund_responsibility", "责任方", "SELECT", True, 20),
        ("reason", "退款原因", "TEXT", True, 30),
    ],
    # ---- 库存操作 ----
    "INVREFUND": [
        ("refund_amount", "退款金额", "NUMBER", True, 10),
        ("reason", "退款原因", "TEXT", True, 20),
    ],
    "INVOID": [
        ("reason", "下架原因", "TEXT", True, 10),
    ],
    "INVCANCEL": [
        ("reason", "取消原因", "TEXT", True, 10),
    ],
    # ---- 工作室 ----
    "STUDIOEXP": [
        ("pool_id", "资金池", "SELECT", True, 10),
        ("occurred_on", "日期", "DATE", True, 20),
        ("direction", "收支", "SELECT", True, 30),
        ("category", "科目", "SELECT", True, 40),
        ("amount", "金额", "NUMBER", True, 50),
        ("note", "备注", "TEXT", False, 60),
    ],
    "STUDIOREJ": [
        ("reason", "拒绝原因", "TEXT", True, 10),
    ],
    "STUDIOREV": [
        ("reversed_on", "冲销日期", "DATE", True, 10),
        ("reason", "冲销原因", "TEXT", True, 20),
    ],
}


def _columns_of(bind, table: str) -> set[str]:
    rows = bind.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return {row[1] for row in rows}


def upgrade() -> None:
    bind = op.get_bind()
    # 1) form_extra 列（幂等）
    for table in FORM_EXTRA_TABLES:
        if "form_extra" not in _columns_of(bind, table):
            op.add_column(
                table,
                sa.Column("form_extra", sa.JSON(), nullable=True),
            )
    # 2) 操作类作用域种子
    session = Session(bind=bind)
    try:
        existing = {
            (row.order_type_code, row.field_key)
            for row in session.scalars(select(OrderFormField))
        }
        rows = []
        for code, fields in SEED.items():
            for key, label, ftype, required, order in fields:
                if (code, key) in existing:
                    continue
                rows.append(
                    OrderFormField(
                        order_type_code=code,
                        field_key=key,
                        label=label,
                        field_type=ftype,
                        required=required,
                        is_active=True,
                        sort_order=order,
                        locked=False,
                        created_by="system",
                        updated_by="system",
                    )
                )
        if rows:
            session.add_all(rows)
            session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        for row in session.scalars(
            select(OrderFormField).where(OrderFormField.order_type_code.in_(SEED))
        ):
            session.delete(row)
        session.commit()
    finally:
        session.close()
    for table in FORM_EXTRA_TABLES:
        if "form_extra" in _columns_of(bind, table):
            op.drop_column(table, "form_extra")
