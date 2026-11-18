"""field_definitions.schemas：基础主数据的请求/响应模型。

金额字段在本阶段为空；一旦出现必须走 `Amount`（DECIMAL(18,2)），禁止 float。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.schemas import RequestModel
from app.domain.enums import PoolStatus, PoolType


class PoolCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    code: str = Field(min_length=2, max_length=64, description="池代码，创建后不可修改")
    name: str = Field(min_length=1, max_length=128)
    # pool_type 是可扩展注册值，不锁死在首批枚举。
    pool_type: str = Field(default=PoolType.OTHER.value, min_length=1, max_length=32)
    # 默认资金账户：未显式指定 pool_id 的流水落这里（全局唯一）。
    is_default: bool = False
    note: str | None = None
    extra_values: dict[str, Any] | None = None


class PoolUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=128)
    note: str | None = None
    # pool_type 是可扩展注册值，不锁死在首批枚举。
    pool_type: str | None = Field(default=None, min_length=1, max_length=32)
    is_default: bool | None = None
    extra_values: dict[str, Any] | None = None


class PoolStatusUpdate(RequestModel):
    status: PoolStatus


class PoolOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    pool_type: str
    status: str
    is_default: bool
    note: str | None = None
    created_at: datetime
    updated_at: datetime
    extra_values: dict[str, Any] = Field(default_factory=dict)


class OrderTypeCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    code: str = Field(min_length=2, max_length=10, description="2-10 位大写字母数字，创建后不可修改")
    name: str = Field(min_length=1, max_length=64)
    is_zero_principal: bool = False
    sequence_prefix: str | None = Field(default=None, max_length=16, description="默认等于 code")
    sort_order: int = 0
    description: str | None = None


class OrderTypeUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=64)
    is_zero_principal: bool | None = None
    description: str | None = None
    sort_order: int | None = None


class OrderTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    is_zero_principal: bool
    business_mode: str | None = None
    business_type: str | None = None
    value_added_service: str | None = None
    sequence_prefix: str
    sequence_key: str
    is_active: bool
    sort_order: int
    description: str | None = None
    created_at: datetime
    updated_at: datetime


class GameTypeCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=64)
    sort_order: int = Field(default=0, ge=0)
    is_default: bool = False
    channel_regions: list[str] = Field(default_factory=list)


class GameTypeUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=64)
    sort_order: int | None = Field(default=None, ge=0)
    channel_regions: list[str] | None = None


class GameTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    sort_order: int
    is_active: bool
    is_default: bool
    channel_regions: list[str] = Field(default_factory=list)

    @field_validator("channel_regions", mode="before")
    @classmethod
    def normalize_channel_regions(cls, value: object) -> list[str]:
        """兼容迁移前或旧数据里的 NULL，前端统一收到空数组。"""
        return value if isinstance(value, list) else []
    created_at: datetime
    updated_at: datetime


class SequenceOut(BaseModel):
    sequence_key: str
    prefix: str
    padding: int
    current_value: int
    next_number: str


__all__ = [
    "OrderTypeCreate",
    "OrderTypeOut",
    "OrderTypeUpdate",
    "GameTypeCreate",
    "GameTypeOut",
    "GameTypeUpdate",
    "PoolCreate",
    "PoolOut",
    "PoolStatusUpdate",
    "PoolUpdate",
    "SequenceOut",
]
