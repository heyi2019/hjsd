"""售出时将买家与交付资料写入当前事务。"""
from collections.abc import Mapping

from sqlalchemy.orm import Session

from app.core.errors import PermissionDenied, Validation
from app.core.security import CurrentUser, PERM_ORDER_UPDATE
from app.shared.order_access import get_order
from .create import add_customer_role
from .mutations import update_order
from .participants import resolve_customer_role
from .schemas import CustomerDraftInput


def sale_form_context(
    customer_input: CustomerDraftInput | None,
    delivery_form_extra: Mapping[str, object] | None,
) -> dict[str, object]:
    """还原售出表单中的客户与交付字段，供条件必填校验使用。"""
    delivery = delivery_form_extra or {}
    context = {key: delivery.get(key) for key in (
        "bound_phone", "bound_phone_owner", "intermediary_platform", "intermediary_platform_other", "intermediary_type",
        "compensation_type", "delivery_responsible_ids",
    )}
    context.update({
        "customer_nickname": customer_input.display_name if customer_input else None,
        "customer_contact_name": customer_input.contact_name if customer_input else None,
        "customer_phone": customer_input.phone if customer_input else None,
        "customer_wechat": customer_input.wechat if customer_input else None,
        "customer_qq": customer_input.qq if customer_input else None,
        "note": customer_input.note if customer_input else None,
    })
    return context


def apply_sale_details(
    db: Session, order_id: int, *, customer_input: CustomerDraftInput | None,
    delivery_form_extra: dict[str, object] | None, user: CurrentUser,
) -> None:
    if not customer_input and not delivery_form_extra:
        return
    if not user.has(PERM_ORDER_UPDATE):
        raise PermissionDenied("当前角色无权更新订单参与方或交付资料")
    order = get_order(db, order_id, user)
    if customer_input:
        expected_role = "CONSIGNOR" if order.order_type == "DG" else "BUYER"
        if customer_input.role != expected_role:
            raise Validation("售出客户角色与订单业务类型不匹配")
        customer_id, role = resolve_customer_role(db, customer_input, user, require_create_permission=True)
        add_customer_role(db, order_id, customer_id, role, actor=user.username, user=user)
    if delivery_form_extra:
        update_order(db, order_id, actor=user.username, form_extra=delivery_form_extra,
                     form_extra_scope=None, user=user)
