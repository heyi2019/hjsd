"""customer_center.router 输出装配 helper（需求池 / 合作方）。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.customers import schemas
from app.customers._common import to_counterparty_out
from app.domain.parties import Customer
from app.shared.form_values import get_extra_values, get_extra_values_bulk
from app.shared.operation_operators import list_operation_operators_bulk


def _lead_output(
    db: Session,
    item,
    *,
    customer_display_name: str | None = None,
    extra_values: dict | None = None,
    operation_operators: list[schemas.LeadOperationOperatorOut] | None = None,
) -> schemas.LeadOut:
    if customer_display_name is None:
        customer = db.get(Customer, item.customer_id)
        customer_display_name = customer.display_name if customer else ""
    if operation_operators is None:
        operators = list_operation_operators_bulk(
            db,
            entity_type="lead",
            entity_ids=[item.lead_no],
        ).get(item.lead_no, [])
    else:
        operators = operation_operators
    output = schemas.LeadOut.model_validate({
        **item.__dict__,
        "customer_display_name": customer_display_name,
        "extra_values": extra_values if extra_values is not None else get_extra_values(
            db, entity_type="lead", entity_id=item.id
        ),
        "operation_operators": [
            schemas.LeadOperationOperatorOut.model_validate(row)
            for row in operators
        ],
    })
    return output


def _lead_outputs(db: Session, items) -> list[schemas.LeadOut]:
    extras = get_extra_values_bulk(
        db, entity_type="lead", entity_ids=[item.id for item in items]
    )
    customer_ids = {item.customer_id for item in items}
    customer_names = dict(
        db.execute(
            select(Customer.id, Customer.display_name).where(Customer.id.in_(customer_ids))
        ).all()
    ) if customer_ids else {}
    operators = list_operation_operators_bulk(
        db,
        entity_type="lead",
        entity_ids=[item.lead_no for item in items],
    )
    return [
        _lead_output(
            db,
            item,
            customer_display_name=customer_names.get(item.customer_id, ""),
            extra_values=extras.get(item.id, {}),
            operation_operators=[
                schemas.LeadOperationOperatorOut.model_validate(row)
                for row in operators.get(item.lead_no, [])
            ],
        )
        for item in items
    ]


def _counterparty_output(db: Session, item) -> schemas.CounterpartyOut:
    data = to_counterparty_out(
        item,
        extra_values=get_extra_values(
            db, entity_type="counterparty", entity_id=item.id
        ),
    )
    return schemas.CounterpartyOut.model_validate(data)
