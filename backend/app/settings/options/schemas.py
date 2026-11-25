"""options.schemas：选项词典的请求/响应模型。"""
from __future__ import annotations

from typing import List, Literal

from pydantic import BaseModel, ConfigDict, Field, model_serializer


class OptionItem(BaseModel):
    """单个选项的 value/label；value 为后端枚举码或字典键，label 为展示名。"""

    model_config = ConfigDict(extra="forbid")

    value: str
    label: str
    behavior: Literal["OTHER", "COMPENSATION"] | None = None

    @model_serializer(mode="wrap")
    def omit_empty_behavior(self, handler):
        result = handler(self)
        if result.get("behavior") is None:
            result.pop("behavior", None)
        return result


class OptionItemCreate(BaseModel):
    """新增字典项时只提交名称，稳定编码由服务端分配。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    label: str = Field(min_length=1, max_length=128)


class CustomDictionaryCreate(BaseModel):
    """自定义字典必须关联已有的选择型扩展字段。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    label: str = Field(min_length=1, max_length=128)
    field_id: int = Field(gt=0)


class CustomDictionaryField(BaseModel):
    field_id: int
    order_type_code: str
    field_key: str
    field_label: str
    scope_label: str
    field_type: str
    is_active: bool


class CustomDictionaryOut(CustomDictionaryField):
    label: str


class CustomDictionaryCatalog(BaseModel):
    items: list[CustomDictionaryOut]
    available_fields: list[CustomDictionaryField]


class OptionSetOut(BaseModel):
    """选项词典输出；options 为 [{value,label}]。"""

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    id: int
    code: str
    label: str
    group: str
    editable: bool
    options: List[OptionItem] | None = None
    description: str | None = None


class OptionSetListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: List[OptionSetOut]


class OptionSetCreate(BaseModel):
    """新建选项词典。"""

    model_config = ConfigDict(extra="forbid")

    code: str
    label: str
    group: str = "GENERAL"
    editable: bool = True
    options: List[OptionItem] = []
    description: str | None = None


class OptionSetUpdate(BaseModel):
    """更新选项词典（部分字段）。"""

    model_config = ConfigDict(extra="forbid")

    label: str | None = None
    group: str | None = None
    editable: bool | None = None
    options: List[OptionItem] | None = None
    description: str | None = None


__all__ = [
    "OptionItem",
    "OptionItemCreate",
    "CustomDictionaryCreate",
    "CustomDictionaryField",
    "CustomDictionaryOut",
    "CustomDictionaryCatalog",
    "OptionSetOut",
    "OptionSetListOut",
    "OptionSetCreate",
    "OptionSetUpdate",
]
