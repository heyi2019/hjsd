"""installments.router：分期合约、收款、交付与逾期标记（HS-01-06）。"""
from __future__ import annotations


from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import Installment, InstallmentSchedule, Order
from app.business.installments import schemas
from app.business.installments import queries as inst_queries
from app.business.installments import action_availability as actions
from app.shared.form_values import get_extra_values_bulk
from app.shared.operation_operators import (
    list_operation_operators_bulk,
)


INSTALLMENT_DETAIL_EXPORT_COLUMNS = [
    ("installment_note", "备注", True),
    ("installment_delivered_on", "交付时间", True),
    ("installment_first_due_on", "首期到期日", True),
    ("installment_extra_values", "合约扩展字段", True),
    ("installment_form_extra", "操作扩展字段", True),
    ("installment_schedule", "期次明细", True),
    ("installment_dispositions", "处置记录", True),
]

def _schedule_output(row: InstallmentSchedule, contract_status: str) -> schemas.ScheduleOut:
    return schemas.ScheduleOut.model_validate({
        **row.__dict__,
        "available_actions": actions.available_schedule_actions(
            row.status, contract_status, due_amount=row.due_amount,
            received_amount=row.received_amount, waived_amount=row.waived_amount,
        ),
    })


def _operation_output(row: Any, installment_id: int, historical_periods: dict[tuple[int, int], int]) -> schemas.OperationOperatorOut:
    parts = row.operation_key.split(":")
    period_no = None
    flow_no = None
    historical_summary = False
    if parts[0] == "PAY" and len(parts) == 3 and parts[1].isdigit():
        period_no, flow_no = int(parts[1]), parts[2]
    elif parts[0] == "PAY" and len(parts) == 2 and parts[1].isdigit():
        period_no = historical_periods.get((installment_id, int(parts[1])))
        historical_summary = True
    return schemas.OperationOperatorOut.model_validate({
        **row.__dict__, "period_no": period_no, "flow_no": flow_no,
        "historical_summary": historical_summary,
    })


def _installment_outputs(
    db: Session,
    items: Sequence[Installment],
    *,
    include_details: bool = False,
) -> list[schemas.InstallmentOut]:
    if not items:
        return []
    extras = get_extra_values_bulk(
        db, entity_type="installment", entity_ids=[item.id for item in items]
    )
    order_ids = {item.order_id for item in items}
    orders = {
        order.id: order
        for order in db.scalars(select(Order).where(Order.id.in_(order_ids))).all()
    }
    order_context = inst_queries.installment_order_context(db, list(orders.values()))
    schedules_by_installment: dict[int, list] = {}
    dispositions_by_installment: dict[int, list] = {}
    if include_details:
        schedules_by_installment, dispositions_by_installment = (
            inst_queries.list_installment_export_details(db, [item.id for item in items])
        )
    operator_rows_by_installment = list_operation_operators_bulk(
        db,
        entity_type="installment",
        entity_ids=[item.inst_no for item in items],
    )
    historical_schedule_ids = {
        int(parts[1])
        for rows in operator_rows_by_installment.values()
        for row in rows
        if len(parts := row.operation_key.split(":")) == 2 and parts[0] == "PAY" and parts[1].isdigit()
    }
    historical_periods = {
        (installment_id, schedule_id): period_no
        for installment_id, schedule_id, period_no in db.execute(
            select(InstallmentSchedule.installment_id, InstallmentSchedule.id, InstallmentSchedule.period_no)
            .where(InstallmentSchedule.id.in_(historical_schedule_ids))
        ).all()
    } if historical_schedule_ids else {}
    return [
        schemas.InstallmentOut.model_validate({
            **item.__dict__,
            "operator": item.created_by,
            "extra_values": extras.get(item.id, {}),
            "order": order_context[item.order_id],
            "schedules": [
                _schedule_output(row, item.status)
                for row in schedules_by_installment.get(item.id, [])
            ],
            "dispositions": [schemas.DispositionOut.model_validate(row) for row in dispositions_by_installment.get(item.id, [])],
            "operation_operators": [
                _operation_output(row, item.id, historical_periods)
                for row in operator_rows_by_installment.get(item.inst_no, [])
            ],
            "available_actions": actions.available_installment_actions(
                item.status,
                [row.action for row in dispositions_by_installment.get(item.id, [])],
            ),
        })
        for item in items
    ]

def _installment_output(db: Session, item: Installment) -> schemas.InstallmentOut:
    return _installment_outputs(db, [item])[0]
