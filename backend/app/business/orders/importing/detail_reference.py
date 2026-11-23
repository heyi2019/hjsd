"""按当前用户可见的导出口径核对已有订单的只读详情。"""
from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.orders.export_fields import (
    ORDER_DETAIL_EXPORT_COLUMNS,
    _account_export_profiles,
    _detail_value_labels,
    _order_detail_export_fields,
    user_name_map,
)
from app.business.orders.router_outputs.detail import _order_details_output
from app.core.security import CurrentUser, PERM_ORDER_UPDATE
from app.domain.trade import Order
from app.settings.lists.export import merge_static_value_labels
from app.settings.lists.service import get_value_labels
from app.shared.scope import owner_scope_filter


def detail_reference_values(
    session: Session, order_numbers: set[str], user: CurrentUser, *, workbook: bool,
) -> dict[str, dict[str, object]]:
    if not order_numbers or not user.has(PERM_ORDER_UPDATE):
        return {}
    query = select(Order).where(Order.order_no.in_(order_numbers))
    scope = owner_scope_filter(Order.owner_id, user, session)
    if scope is not None:
        query = query.where(scope)
    orders = list(session.scalars(query).all())
    if not orders:
        return {}
    labels = {**get_value_labels(session, "LEDGER"), **_detail_value_labels(session)}
    if workbook:
        labels = merge_static_value_labels(labels)
    names = user_name_map(session)
    profiles = _account_export_profiles(session, orders)
    details = _order_details_output(session, orders, user)
    result = {}
    for order, detail in zip(orders, details, strict=True):
        values = _order_detail_export_fields(
            detail.model_dump(mode="json"), labels, names, profiles.get(order.account_id),
        )
        result[order.order_no] = {label: values.get(key) for key, label, _ in ORDER_DETAIL_EXPORT_COLUMNS}
    return result


def same_readonly_detail(actual: str, expected: object) -> bool:
    """展示 JSON 可改空白和键顺序，但不能修改其实际内容。"""
    left = actual.strip()
    right = "" if expected is None else str(expected).strip()
    if left == right:
        return True
    try:
        left_json, right_json = json.loads(left), json.loads(right)
        if not isinstance(left_json, (dict, list)) or type(left_json) is not type(right_json):
            return False
        options = {"sort_keys": True, "ensure_ascii": False, "separators": (",", ":"), "allow_nan": False}
        return json.dumps(left_json, **options) == json.dumps(right_json, **options)
    except (TypeError, ValueError):
        return False
