"""domain.options：通用选项词典（D 类筛选器 / 业务字典的单一事实源）。

可与 order_form_fields（表单字段配置）区分：本表面向「页面筛选项 / 业务字典」，
不绑定任何表单作用域；options 为 [{value,label}] 列表。纯字典类 editable=True
（可增删改值），后端死枚举类 editable=False（只读展示，值受后端 CHECK 约束）。
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import JSON, Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.base import Base
from app.domain.base import AuditMixin

CUSTOM_DICTIONARY_REGISTRY = "CUSTOM_FIELD_DICTIONARIES"


def custom_dictionary_bindings(options: list | None) -> list[tuple[int, str]]:
    """解析自定义字段与字典名称的关联，发现异常时拒绝覆盖原配置。"""
    if options is None:
        return []
    if not isinstance(options, list):
        raise ValueError("自定义字典配置格式不正确")
    result: list[tuple[int, str]] = []
    seen: set[int] = set()
    for item in options:
        if not isinstance(item, dict):
            raise ValueError("自定义字典配置格式不正确")
        value, label = item.get("value"), item.get("label")
        if not isinstance(value, str) or not value.isascii() or not value.isdigit() or int(value) <= 0:
            raise ValueError("自定义字典关联字段不正确")
        if not isinstance(label, str) or not label.strip() or int(value) in seen:
            raise ValueError("自定义字典配置重复或名称为空")
        field_id = int(value)
        seen.add(field_id)
        result.append((field_id, label))
    return result


class OptionSet(Base, AuditMixin):
    """通用选项词典：按 code 唯一标识一组选项。"""

    __tablename__ = "option_sets"
    __table_args__ = (
        sa.Index("ix_option_sets_group", "group"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    group: Mapped[str] = mapped_column(String(64), nullable=False, server_default="GENERAL")
    # editable=False 表示后端死枚举（只读，值受 CHECK 约束），True 为纯字典可增删改
    editable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa.true()
    )
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


__all__ = ["CUSTOM_DICTIONARY_REGISTRY", "OptionSet", "custom_dictionary_bindings"]
