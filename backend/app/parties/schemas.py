"""parties.schemas：客户、合作方、活字段的请求/响应模型。

联系方式对外**默认脱敏**；只有具备 `customer.contact.read` 且显式请求时才返回完整值。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel
from app.domain.enums import CounterpartyType, CustomerStatus


class CustomerCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str = Field(min_length=1, max_length=128, description="称呼/昵称，必填")
    contact_name: str | None = Field(default=None, max_length=128)
    phone: str | None = Field(default=None, max_length=64)
    wechat: str | None = Field(default=None, max_length=128)
    qq: str | None = Field(default=None, max_length=64)
    source: str | None = Field(default=None, max_length=64)
    owner_id: int | None = None
    tags: list[str] | None = None
    note: str | None = None
    extra_values: dict[str, Any] | None = Field(
        default=None, description="活字段值：field_key → 值，仅接受已启用的字段定义（BAS-04-04）"
    )


class CustomerUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    owner_id: int | None = None
    tags: list[str] | None = None
    note: str | None = None
    extra_values: dict[str, Any] | None = None


class CustomerStatusUpdate(RequestModel):
    status: CustomerStatus


class DuplicateCandidate(BaseModel):
    """重复候选：只提示，不拦截建档（CUS-01-05）。"""

    customer_id: int
    customer_no: str
    display_name: str
    matched_on: list[str]


class CustomerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_no: str
    display_name: str
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    owner_id: int | None = None
    status: str
    tags: list[str] | None = None
    note: str | None = None
    merged_into_id: int | None = None
    contact_masked: bool = True
    extra_values: dict[str, Any] = Field(default_factory=dict)


class CustomerWithCandidates(BaseModel):
    customer: CustomerOut
    duplicate_candidates: list[DuplicateCandidate] = Field(default_factory=list)


class MergeRequest(RequestModel):
    target_customer_id: int
    reason: str = Field(min_length=1, max_length=500)


class CounterpartyCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str = Field(min_length=1, max_length=128)
    type: CounterpartyType
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = Field(default=None, max_length=64)
    note: str | None = None


class CounterpartyUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    note: str | None = None


class CounterpartyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    counterparty_no: str
    display_name: str
    type: str
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    qq: str | None = None
    source: str | None = None
    status: str
    note: str | None = None
    created_at: datetime


class FieldDefinitionCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    entity_type: str = Field(min_length=1, max_length=32)
    field_key: str = Field(min_length=1, max_length=64, description="小写字母数字下划线")
    label: str = Field(min_length=1, max_length=128)
    field_type: str = "TEXT"
    options: list[str] | None = None
    required: bool = False
    sort_order: int = 0


class FieldDefinitionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    entity_type: str
    field_key: str
    label: str
    field_type: str
    options: list[str] | None = None
    required: bool
    sort_order: int
    is_active: bool


class ExtraValueIn(RequestModel):
    field_key: str
    value: str | int | float | bool | list | dict | None = None


__all__ = [
    "CounterpartyCreate",
    "CounterpartyOut",
    "CounterpartyUpdate",
    "CustomerCreate",
    "CustomerOut",
    "CustomerStatusUpdate",
    "CustomerUpdate",
    "CustomerWithCandidates",
    "DuplicateCandidate",
    "ExtraValueIn",
    "FieldDefinitionCreate",
    "FieldDefinitionOut",
    "MergeRequest",
]
