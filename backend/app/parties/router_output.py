"""parties.router 输出装配 helper（需求池 / 合作方）。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.parties import schemas
from app.parties._common import to_counterparty_out
from app.domain.parties import Customer
from app.parties.fields import get_extra_values


def _lead_output(
    db: Session,
    item,
    *,
    customer_display_name: str | None = None,
    extra_values: dict | None = None,
) -> schemas.LeadOut:
    if customer_display_name is None:
        customer = db.get(Customer, item.customer_id)
        customer_display_name = customer.display_name if customer else ""
    output = schemas.LeadOut.model_validate({
        **item.__dict__,
        "customer_display_name": customer_display_name,
        "extra_values": extra_values if extra_values is not None else get_extra_values(
            db, entity_type="lead", entity_id=item.id
        ),
    })
    return output


def _counterparty_output(db: Session, item) -> schemas.CounterpartyOut:
    data = to_counterparty_out(
        item,
        extra_values=get_extra_values(
            db, entity_type="counterparty", entity_id=item.id
        ),
    )
    return schemas.CounterpartyOut.model_validate(data)
