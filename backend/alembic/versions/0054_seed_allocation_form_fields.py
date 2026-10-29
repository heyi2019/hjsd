"""为订单分润表单补齐核心字段配置。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision = "0054_seed_allocation_form_fields"
down_revision = "0053_add_list_custom_columns"
branch_labels = None
depends_on = None

# (field_key, label, field_type, required, sort_order)
SEED = (
    ("employee", "姓名", "SELECT", True, 10),
    ("role", "角色", "SELECT", False, 20),
    ("allocation_rate", "比例", "TEXT", False, 30),
    ("allocation_amount", "金额", "TEXT", False, 40),
)


def upgrade() -> None:
    session = Session(bind=op.get_bind())
    try:
        existing = {
            row.field_key
            for row in session.scalars(
                select(OrderFormField).where(OrderFormField.order_type_code == "ALLOCATION")
            )
        }
        for field_key, label, field_type, required, sort_order in SEED:
            if field_key in existing:
                continue
            session.add(
                OrderFormField(
                    order_type_code="ALLOCATION",
                    field_key=field_key,
                    label=label,
                    field_type=field_type,
                    required=required,
                    is_active=True,
                    sort_order=sort_order,
                    locked=True,
                    is_custom=False,
                    created_by="system",
                    updated_by="system",
                )
            )
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    session = Session(bind=op.get_bind())
    try:
        session.query(OrderFormField).filter(
            OrderFormField.order_type_code == "ALLOCATION",
            OrderFormField.field_key.in_([row[0] for row in SEED]),
        ).delete(synchronize_session=False)
        session.commit()
    finally:
        session.close()
