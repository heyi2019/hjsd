"""foundation.schemas：基础主数据的请求/响应模型。

金额字段在本阶段为空；一旦出现必须走 `Amount`（DECIMAL(18,2)），禁止 float。
"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.domain.enums import CapitalType, PoolOwnership, PoolStatus, PoolType, Portion


class PoolCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    code: str = Field(min_length=2, max_length=64, description="池代码，创建后不可修改")
    name: str = Field(min_length=1, max_length=128)
    pool_type: PoolType = PoolType.OTHER
    ownership: PoolOwnership = PoolOwnership.OWNED
    note: str | None = None


class PoolUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=128)
    note: str | None = None
    pool_type: PoolType | None = None
    ownership: PoolOwnership | None = None


class PoolStatusUpdate(BaseModel):
    status: PoolStatus


class PoolOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    pool_type: str
    ownership: str
    status: str
    note: str | None = None
    created_at: datetime
    updated_at: datetime


class OrderTypeCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    code: str = Field(min_length=2, max_length=10, description="2-10 位大写字母数字，创建后不可修改")
    name: str = Field(min_length=1, max_length=64)
    capital_type: CapitalType
    sequence_prefix: str | None = Field(default=None, max_length=16, description="默认等于 code")
    sort_order: int = 0
    description: str | None = None


class OrderTypeUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = None
    sort_order: int | None = None


class OrderTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    capital_type: str
    sequence_prefix: str
    sequence_key: str
    is_active: bool
    sort_order: int
    description: str | None = None
    created_at: datetime
    updated_at: datetime


class RouteIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    portion: Portion
    pool_code: str = Field(min_length=2, max_length=64)
    priority: int = 0


class RouteOut(BaseModel):
    id: int
    order_type_code: str
    portion: str
    pool_code: str
    pool_name: str
    priority: int
    is_active: bool


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
    "PoolCreate",
    "PoolOut",
    "PoolStatusUpdate",
    "PoolUpdate",
    "RouteIn",
    "RouteOut",
    "SequenceOut",
]
