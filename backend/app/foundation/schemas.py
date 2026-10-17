"""foundation.schemas：基础主数据的请求/响应模型。

金额字段在本阶段为空；一旦出现必须走 `Amount`（DECIMAL(18,2)），禁止 float。
"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel
from app.domain.enums import CapitalType, PoolOwnership, PoolStatus, PoolType, Portion


class PoolCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    code: str = Field(min_length=2, max_length=64, description="池代码，创建后不可修改")
    name: str = Field(min_length=1, max_length=128)
    # pool_type 是可扩展注册值，不锁死在首批枚举。
    pool_type: str = Field(default=PoolType.OTHER.value, min_length=1, max_length=32)
    ownership: PoolOwnership = PoolOwnership.OWNED
    note: str | None = None


class PoolUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=128)
    note: str | None = None
    # pool_type 是可扩展注册值，不锁死在首批枚举。
    pool_type: str | None = Field(default=None, min_length=1, max_length=32)
    ownership: PoolOwnership | None = None


class PoolStatusUpdate(RequestModel):
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


class OrderTypeCreate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    code: str = Field(min_length=2, max_length=10, description="2-10 位大写字母数字，创建后不可修改")
    name: str = Field(min_length=1, max_length=64)
    capital_type: CapitalType
    sequence_prefix: str | None = Field(default=None, max_length=16, description="默认等于 code")
    sort_order: int = 0
    description: str | None = None


class OrderTypeUpdate(RequestModel):
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


class RouteIn(RequestModel):
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


class RouteImpactPreviewOut(BaseModel):
    order_type: str
    portion: str
    current_route: dict | None = None
    proposed_route: dict
    changed: bool
    historical_impact: dict
    future_effect: str


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
    "RouteImpactPreviewOut",
    "RouteOut",
    "SequenceOut",
]
