"""settings.field_definitions.router_output：资金账户 / 业务类型的输出装配 helper。"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.domain.foundation import Pool
from app.settings.field_definitions import schemas
from app.settings.field_definitions.classification import classification_for_order_type
from app.shared.form_values import get_extra_values


def _pool_output(db: Session, pool: Pool) -> schemas.PoolOut:
    output = schemas.PoolOut.model_validate(pool)
    output.extra_values = get_extra_values(
        db, entity_type="pool", entity_id=pool.id
    )
    return output


def _order_type_output(order_type: Any) -> schemas.OrderTypeOut:
    payload = schemas.OrderTypeOut.model_validate(order_type)
    classification = classification_for_order_type(order_type.code)
    if classification:
        payload.business_mode = classification["business_mode"]
        payload.business_type = classification["business_type"]
        payload.value_added_service = classification["value_added_service"]
    return payload
