"""业务表单配置的请求与响应模型。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FlowDirection = Literal["BASE", "IN", "OUT"]


class FieldOption(BaseModel):
    value: str
    label: str


class RequiredWhen(BaseModel):
    """条件必填条件：依赖同作用域内某个字段的取值。

    - op=eq：依赖字段值属于 values 任一 → 必填；
    - op=ne：依赖字段值不属于 values → 必填；
    - op=filled：依赖字段有值（非空字符串/非 null）→ 必填，此时 values 必须为空。
    """

    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1, max_length=64)
    op: str = Field(default="eq", pattern="^(eq|ne|filled)$")
    values: list[str] | None = None


class OrderFormFieldOut(BaseModel):
    """建单表单字段配置响应。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    order_type_code: str
    field_key: str
    label: str
    field_type: str
    options: list[FieldOption] | None = None
    flow_direction: FlowDirection | None = None
    required: bool
    required_when: RequiredWhen | None = None
    is_active: bool
    sort_order: int
    locked: bool
    is_custom: bool
    section: str = "EXTRA"
    note: str | None = None


class FormScopeOut(BaseModel):
    """表单作用域（设置页「表单」下拉清单，来自 form_scopes 注册表）。"""

    code: str
    label: str
    group: str


class OrderFormFieldCreate(BaseModel):
    """新增建单表单字段（自定义字段）。核心字段由种子锁定，不可经此创建覆盖。"""

    model_config = ConfigDict(extra="forbid")

    order_type_code: str = Field(min_length=2, max_length=16)
    field_key: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=128)
    field_type: str = "TEXT"
    options: list[FieldOption] | None = None
    flow_direction: FlowDirection | None = None
    required: bool = False
    required_when: RequiredWhen | None = None
    is_active: bool = True
    sort_order: int = 0
    is_custom: bool = True
    section: str = Field(default="EXTRA", pattern="^[A-Z][A-Z0-9_]{0,31}$")
    note: str | None = None


class SectionLabelsSaveIn(BaseModel):
    """保存某业务类型的板块标题：order_type_code 须为已注册作用域，labels 为板块键→标题。"""

    model_config = ConfigDict(extra="forbid")

    order_type_code: str = Field(min_length=2, max_length=16)
    labels: dict[str, str]


class SectionRenameIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_type_code: str = Field(min_length=2, max_length=16)
    from_key: str = Field(min_length=1, max_length=32)
    to_key: str = Field(min_length=1, max_length=32)
    label: str = Field(min_length=1, max_length=128)


class OrderFormFieldUpdate(BaseModel):
    """编辑建单表单字段：label/类型/选项/必填态（含条件必填）/排序/备注均可改；field_key 与 code 固定。

    required_when 语义：不传=保持不变；传 null=清除条件（回退纯选填）；传对象=设为条件必填。
    """

    model_config = ConfigDict(extra="forbid")

    label: str | None = None
    field_type: str | None = None
    options: list[FieldOption] | None = None
    flow_direction: FlowDirection | None = None
    required: bool | None = None
    required_when: RequiredWhen | None = None
    sort_order: int | None = None
    section: str | None = Field(default=None, pattern="^[A-Z][A-Z0-9_]{0,31}$")
    note: str | None = None
