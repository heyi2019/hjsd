"""订单详情视图的后端输出契约。

这些字段是详情页的业务派生结果，避免浏览器根据原始事件重新推导口径。
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class DetailExecutionRowOut(BaseModel):
    key: str
    order_id: int
    category: str
    action: str
    occurred_at: datetime | None = None
    amount: Decimal | None = None
    operator: str
    note: str
    platform: str
    event_id: int | None = None


class DetailFinanceRowOut(BaseModel):
    key: str
    flow_no: str
    type: str
    direction: str
    amount: Decimal
    occurred_at: datetime | None = None
    pool_name: str
    note: str
    operator: str
    event_id: int | None = None


class DetailOperationRowOut(BaseModel):
    key: str
    action: str
    content: str
    occurred_at: datetime | None = None
    operator: str
    event_id: int | None = None


class DetailLifecycleOut(BaseModel):
    sold_at: datetime | None = None
    removed_at: datetime | None = None
    removed_platform: str = "-"
    recovery_platform: str = "-"
    sale_platform: str = "-"


class DetailPartyOut(BaseModel):
    id: int
    display_name: str
    role: str
    entity_type: str


class DetailExtraOut(BaseModel):
    key: str
    label: str
    value: str
    section: str


class OrderDetailViewOut(BaseModel):
    execution_rows: list[DetailExecutionRowOut] = Field(default_factory=list)
    finance_rows: list[DetailFinanceRowOut] = Field(default_factory=list)
    operation_rows: list[DetailOperationRowOut] = Field(default_factory=list)
    lifecycle: DetailLifecycleOut
    order_notes: str = "-"
    parties: list[DetailPartyOut] = Field(default_factory=list)
    extras: list[DetailExtraOut] = Field(default_factory=list)
