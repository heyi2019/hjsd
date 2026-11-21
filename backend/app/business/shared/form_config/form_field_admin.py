"""orders.form_field_admin：表单字段定义的增删改查、启停与依赖护栏。

实现已拆至 `orders/form_field_admin_ops/`（guards / writes / list）；
`guards.FIXED_LABEL_FIELD_KEYS` 与依赖护栏仍是写入路径的唯一裁决点。
本文件保留整合出口，调用方无需改动。
"""
from __future__ import annotations
from app.business.shared.form_config.form_field_admin_ops.guards import (
    FIXED_LABEL_FIELD_KEYS, _dependent_field_labels, _reject_if_dependent,
)
from app.business.shared.form_config.form_field_admin_ops.writes import (
    create_order_form_field, delete_order_form_field, set_order_form_field_active,
    update_order_form_field,
)
from app.business.shared.form_config.form_field_admin_ops.list import list_order_form_fields
__all__ = [
    "FIXED_LABEL_FIELD_KEYS","create_order_form_field","update_order_form_field",
    "list_order_form_fields","set_order_form_field_active","delete_order_form_field",
    "_dependent_field_labels","_reject_if_dependent",
]
