"""lead_form_scopes：补客户需求池「关闭原因」「转单」两个单字段弹窗的可配置作用域

0003 已覆盖 27 个作用域，但客户需求池的「关闭客户需求」（reason）
与「需求转单」（order_id）两个弹窗当时未纳入。这两个虽然是单字段表单，
用户同样有改标签 / 改必填 / 停用的诉求，一并纳入统一的配置体系。

注意：作用域码上限是 max_length=16（见 OrderFormFieldBase.order_type_code），
不是 0003 注释中误记的 2-10 位。

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-10-26 02:40:00.000000

"""
from __future__ import annotations

from typing import Sequence

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision: str = 'c3d4e5f6a7b8'
down_revision: str | None = 'b2c3d4e5f6a7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 元组：(field_key, label, field_type, required, sort_order)
SEED: dict[str, list[tuple[str, str, str, bool, int]]] = {
    # ---- 客户 ----
    "LEADCLOSE": [
        ("reason", "关闭原因", "TEXT", True, 10),
    ],
    "LEADCONVERT": [
        ("order_id", "订单 ID", "TEXT", True, 10),
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
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
