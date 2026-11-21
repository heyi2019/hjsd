"""orders 执行详情编辑路由（ORD-01）。

从 orders/router.py 按资源拆分，函数体一字未改，URL 与挂载点不变。
"""

from typing import Literal

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import Conflict, NotFound, PermissionDenied, Validation
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_ORDER_UPDATE,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.shared.order_access import get_order as orders_get_order
from app.business.order_detail.editing import edit_execution_detail
from app.business.order_detail.editing.schemas import ExecutionEditRequest
from app.business.order_detail.view.execution import load_order_execution_detail
from app.business.order_detail.view.execution_schemas import AccountExecutionDetailOut
from app.business.order_detail.view.image_previews import account_image_versions, image_version, preview_account_images
from app.business.inventory.profile import get_account


router = APIRouter(tags=["ORD-01/02 订单与事件"])


read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
update_orders = require_permissions(PERM_ORDER_UPDATE)
edit_order_detail = require_permissions(PERM_ORDER_UPDATE)

@router.get("/orders/{order_id}/execution-detail", response_model=AccountExecutionDetailOut)
def order_execution_detail(
    order_id: int,
    image_previews: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> AccountExecutionDetailOut:
    """查询一个订单及其强绑定账号的执行详情。"""
    detail = load_order_execution_detail(db, order_id, user)
    if image_previews:
        return detail.model_copy(update={
            "account": preview_account_images(detail.account), "image_previews": True,
            "image_versions": account_image_versions(detail.account),
        })
    return detail


@router.get("/orders/{order_id}/execution-images/{field}/{index}")
def order_execution_image(
    order_id: int,
    field: Literal["secondary_images", "wallet_realname_images", "account_images"],
    index: int = Path(ge=0),
    version: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> dict[str, str]:
    order = orders_get_order(db, order_id, user)
    if order.account_id is None:
        raise NotFound("订单未关联库存账号")
    account = get_account(db, order.account_id, user)
    images = getattr(account, field) or []
    if index >= len(images):
        raise NotFound("图片不存在")
    if version is not None and image_version(images[index]) != version:
        raise Conflict("图片已更新，请刷新详情后重试")
    return {"image": images[index]}


@router.patch("/orders/{order_id}/execution-edit")
def update_order_execution_detail(
    order_id: int,
    payload: ExecutionEditRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = edit_order_detail,
) -> dict[str, bool]:
    """保存一个订单及其强绑定账号的详情编辑。"""
    if payload.new_events and not user.has(PERM_ORDER_EVENT_POST):
        raise PermissionDenied("当前角色无权登记运营事件")
    order = orders_get_order(db, order_id, user)
    if order.account_id is None:
        raise Validation("订单未关联库存账号", details={"order_id": order_id})
    edit_execution_detail(db, order_id, payload, user)
    return {"ok": True}

__all__ = ["router"]
