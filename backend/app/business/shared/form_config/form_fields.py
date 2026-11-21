"""orders.form_fields：建单表单字段配置的 CRUD 与护栏。

本模块是**全站唯一的表单字段配置来源**：描述「建单表单」与「客户建档」等表单的字段构成
（显示/必填/停用/排序/增删），不存储实体附加属性值。自定义字段（is_custom=1）即扩展字段，
其值落在所属实体行内的 form_extra：建单订单使用 Order.form_extra，账号/产品字段写入
Account.form_extra，客户建档字段使用 Customer.form_extra；同一字段定义仍由本表统一维护。
核心核算字段 locked=True，仅禁止物理删除；required 与 is_active 仍可按业务需要配置
（停用核心字段由前端提示风险）。
"""
from __future__ import annotations

from .form_field_admin_ops.writes import (
    create_order_form_field,
    update_order_form_field,
    set_order_form_field_active,
    delete_order_form_field,
)
from .form_field_admin_ops.list import list_order_form_fields
from .section_labels import (
    get_section_labels,
    rename_form_section,
    save_section_labels,
)

__all__ = [
    "create_order_form_field",
    "delete_order_form_field",
    "get_section_labels",
    "list_order_form_fields",
    "rename_form_section",
    "save_section_labels",
    "set_order_form_field_active",
    "update_order_form_field",
]
