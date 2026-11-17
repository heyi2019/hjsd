"""orders 关联订单路由（ORD-01）。

从 orders/router.py 按资源拆分，函数体一字未改，URL 与挂载点不变。
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_ORDER_UPDATE,
    CurrentUser,
)
from app.auth.session import (
    require_permissions,
)
from app.orders import schemas
from app.orders.links import (
    create_order_link as orders_create_order_link,
    delete_order_link as orders_delete_order_link,
    list_order_links as orders_list_order_links,
)

from ..router_output import (
    _actor,
)

router = APIRouter(tags=["ORD-01/02 订单与事件"])


read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
update_orders = require_permissions(PERM_ORDER_UPDATE)
edit_order_detail = require_permissions(PERM_ORDER_UPDATE)

@router.get("/orders/{order_id}/links", response_model=list[schemas.OrderLinkOut])
def list_order_links(
    order_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> list[schemas.OrderLinkOut]:
    return [
        schemas.OrderLinkOut.model_validate(item)
        for item in orders_list_order_links(db, order_id, user)
    ]
@router.post(
    "/orders/{order_id}/links",
    response_model=schemas.OrderLinkOut,
    status_code=201,
)
def create_order_link(
    order_id: int,
    payload: schemas.OrderLinkCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderLinkOut:
    link = orders_create_order_link(
        db,
        order_id,
        related_order_id=payload.related_order_id,
        relation_type=payload.relation_type,
        split_ratio=payload.split_ratio,
        split_amount=payload.split_amount,
        note=payload.note,
        form_extra=payload.form_extra,
        actor=_actor(user),
        user=user,
    )
    item = next(
        item for item in orders_list_order_links(db, order_id, user) if item["id"] == link.id
    )
    return schemas.OrderLinkOut.model_validate(item)
@router.delete("/orders/{order_id}/links/{link_id}", status_code=204, response_model=None)
def delete_order_link(
    order_id: int,
    link_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> None:
    orders_delete_order_link(db, order_id, link_id, actor=_actor(user), user=user)

__all__ = ["router"]
