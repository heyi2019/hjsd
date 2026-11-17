"""foundation.router 输出装配 helper（资金账户 / 业务类型）。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.field_definitions import schemas
from app.field_definitions.classification import classification_for_order_type
from app.shared.form_values import get_extra_values


def _pool_output(db: Session, pool) -> schemas.PoolOut:
    output = schemas.PoolOut.model_validate(pool)
    output.extra_values = get_extra_values(
        db, entity_type="pool", entity_id=pool.id
    )
    return output


def _order_type_output(order_type) -> schemas.OrderTypeOut:
    payload = schemas.OrderTypeOut.model_validate(order_type)
    classification = classification_for_order_type(order_type.code)
    if classification:
        payload.business_mode = classification["business_mode"]
        payload.business_type = classification["business_type"]
        payload.value_added_service = classification["value_added_service"]
    return payload
