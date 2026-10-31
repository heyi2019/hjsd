"""将订单退款表单调整为资金支出表单字段。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision = "0057_update_refund_cashflow_form_fields"
down_revision = "0056_merge_distribution_installment_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    session = Session(bind=op.get_bind())
    try:
        rows = {
            row.field_key: row
            for row in session.scalars(
                select(OrderFormField).where(OrderFormField.order_type_code == "REFUND")
            )
        }

        responsibility = rows.get("refund_responsibility")
        if responsibility is not None:
            responsibility.is_active = False
            responsibility.updated_by = "system"

        amount = rows.get("amount")
        if amount is not None:
            amount.label = "金额"
            amount.section = "FINANCE"
            amount.flow_direction = "OUT"

        reason = rows.get("reason")
        if reason is not None:
            reason.label = "收支备注"
            reason.section = "FINANCE"

        if "occurred_on" not in rows:
            session.add(
                OrderFormField(
                    order_type_code="REFUND",
                    field_key="occurred_on",
                    label="发生日期",
                    field_type="DATE",
                    required=True,
                    is_active=True,
                    sort_order=10,
                    locked=True,
                    is_custom=False,
                    section="FINANCE",
                    created_by="system",
                    updated_by="system",
                )
            )

        if "direction" not in rows:
            session.add(
                OrderFormField(
                    order_type_code="REFUND",
                    field_key="direction",
                    label="资金流向",
                    field_type="SELECT",
                    options=[{"value": "OUT", "label": "支出"}],
                    required=True,
                    is_active=True,
                    sort_order=20,
                    locked=True,
                    is_custom=False,
                    section="FINANCE",
                    created_by="system",
                    updated_by="system",
                )
            )

        if amount is not None:
            amount.sort_order = 30
        if reason is not None:
            reason.sort_order = 40
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    session = Session(bind=op.get_bind())
    try:
        session.query(OrderFormField).filter(
            OrderFormField.order_type_code == "REFUND",
            OrderFormField.field_key.in_(["occurred_on", "direction"]),
        ).delete(synchronize_session=False)
        responsibility = session.scalar(
            select(OrderFormField).where(
                OrderFormField.order_type_code == "REFUND",
                OrderFormField.field_key == "refund_responsibility",
            )
        )
        if responsibility is not None:
            responsibility.is_active = True
        session.commit()
    finally:
        session.close()

