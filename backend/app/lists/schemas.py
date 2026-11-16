"""lists.schemas：列表列配置的出入参。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ListColumnOut(BaseModel):
    """一列的当前配置：文案/锁定态来自注册表，可见性/顺序/固定态来自库。
    `custom=True` 的行是管理员新增的自定义列：`source_key` 是行数据扩展字段里的键，
    `value_labels` 是选项码 → 中文的快照（渲染与导出共用）。
    """

    key: str
    label: str
    locked: bool
    is_visible: bool
    sort_order: int
    fixed: Literal["left", "right"] | None = None
    custom: bool = False
    source_key: str | None = None
    value_labels: dict[str, str] | None = None


class ListScopeOut(BaseModel):
    code: str
    label: str
    columns: list[ListColumnOut]


class ListColumnItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column_key: str = Field(min_length=1, max_length=80)
    is_visible: bool
    sort_order: int = Field(ge=0)
    fixed: Literal["left", "right"] | None = None


class ListColumnSave(BaseModel):
    """保存某个列表的列配置：按数组顺序落 sort_order，整表覆盖该 scope。"""

    model_config = ConfigDict(extra="forbid")

    items: list[ListColumnItem]


class ListCustomColumnCreate(BaseModel):
    """新增自定义列：绑定一个已启用的表单自定义字段，列名可覆盖。"""

    model_config = ConfigDict(extra="forbid")

    field_key: str = Field(min_length=1, max_length=64)
    label: str | None = Field(default=None, max_length=64)


class CustomFieldOptionOut(BaseModel):
    """可选作自定义列来源的字段（设置页新增弹窗的候选项）。

    两类来源：表单自定义字段（data_only=False，SELECT 带选项快照）；
    数据中已有值的键（data_only=True，历史流程写入但无字段定义，按原值展示）。
    """

    scope: str
    scope_label: str
    field_key: str
    label: str
    field_type: str
    options: list[dict[str, str]] = Field(default_factory=list)
    data_only: bool = False
    source_label: str | None = None
    row_count: int | None = None


__all__ = [
    "CustomFieldOptionOut",
    "ListColumnItem",
    "ListColumnOut",
    "ListColumnSave",
    "ListCustomColumnCreate",
    "ListScopeOut",
]
