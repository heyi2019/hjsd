"""foundation.router 输出装配 helper（资金池 / 业务类型）。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.security import CurrentUser
from app.foundation import schemas
from app.foundation.classification import classification_for_order_type
from app.parties.fields import get_extra_values

def _actor(user: CurrentUser) -> str:
    return user.username


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


def _route_out(route) -> schemas.RouteOut:
    return schemas.RouteOut(
        id=route.id,
        order_type_code=route.order_type.code,
        portion=route.portion,
        fund_nature=route.fund_nature,
        pool_code=route.pool.code,
        pool_name=route.pool.name,
        priority=route.priority,
        is_active=route.is_active,
    )
