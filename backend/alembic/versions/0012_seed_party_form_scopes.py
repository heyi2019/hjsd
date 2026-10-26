"""Seed configurable forms for customer and counterparty onboarding.

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-10-26 21:00:00.000000
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision: str = "e1f2a3b4c5d6"
down_revision: str | None = "d0e1f2a3b4c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SEED: dict[str, list[tuple[str, str, str, bool, int]]] = {
    "CUSTOMER": [
        ("display_name", "名字", "TEXT", True, 10),
        ("contact_name", "联系人姓名", "TEXT", False, 20),
        ("phone", "手机号", "TEXT", False, 30),
        ("wechat", "微信号", "TEXT", False, 40),
        ("qq", "QQ", "TEXT", False, 50),
        ("note", "备注", "TEXT", False, 60),
    ],
    "COUNTERPARTY": [
        ("display_name", "名称", "TEXT", True, 10),
        ("type", "类型", "SELECT", True, 20),
        ("contact_name", "联系人", "TEXT", False, 30),
        ("phone", "手机号", "TEXT", False, 40),
        ("wechat", "微信号", "TEXT", False, 50),
    ],
}


def upgrade() -> None:
    session = Session(op.get_bind())
    try:
        existing = {
            (row.order_type_code, row.field_key)
            for row in session.scalars(select(OrderFormField))
        }
        session.add_all(
            OrderFormField(
                order_type_code=scope,
                field_key=key,
                label=label,
                field_type=field_type,
                required=required,
                is_active=True,
                sort_order=sort_order,
                locked=False,
                created_by="system",
                updated_by="system",
            )
            for scope, fields in SEED.items()
            for key, label, field_type, required, sort_order in fields
            if (scope, key) not in existing
        )
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    session = Session(op.get_bind())
    try:
        for row in session.scalars(
            select(OrderFormField).where(OrderFormField.order_type_code.in_(SEED))
        ):
            session.delete(row)
        session.commit()
    finally:
        session.close()
