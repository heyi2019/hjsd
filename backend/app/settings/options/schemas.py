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
    "OptionSetOut",
    "OptionSetListOut",
    "OptionSetCreate",
    "OptionSetUpdate",
]
