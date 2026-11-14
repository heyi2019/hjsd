"""订单详情编辑请求模型。

库存列表和库存统计模型留在 `stocks.schemas`；详情编辑输入只在本目录维护。
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import Field

from app.core.schemas import RequestModel

from app.stocks.schemas import AccountProfileUpdate


class ExecutionEditItem(RequestModel):
    id: int = Field(gt=0)
    expected_amount: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    amount: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    note: str | None = None
    occurred_at: datetime | None = None
    form_extra: dict[str, object] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class ExecutionCashflowEditItem(RequestModel):
    flow_no: str = Field(min_length=1, max_length=32)
    occurred_at: datetime | None = None
    note: str | None = None
    operator: str | None = Field(default=None, max_length=64)


class ExecutionOrderEditItem(RequestModel):
    order_id: int = Field(gt=0)
    occurred_at: datetime | None = None
    operator: str | None = Field(default=None, min_length=1, max_length=64)
    note: str | None = None
    form_extra: dict[str, object] | None = None


class ExecutionPartyEditItem(RequestModel):
    order_id: int = Field(gt=0)
    entity_type: Literal["customer", "counterparty"]
    entity_id: int = Field(gt=0)
    role: str = Field(min_length=1, max_length=64)


class ExecutionEditRequest(RequestModel):
    events: list[ExecutionEditItem] = Field(max_length=100)
    cashflows: list[ExecutionCashflowEditItem] = Field(default_factory=list, max_length=100)
    orders: list[ExecutionOrderEditItem] = Field(default_factory=list, max_length=20)
    parties: list[ExecutionPartyEditItem] = Field(default_factory=list, max_length=50)
    profile: AccountProfileUpdate | None = None


__all__ = [
    "ExecutionEditItem",
    "ExecutionCashflowEditItem",
    "ExecutionOrderEditItem",
    "ExecutionPartyEditItem",
    "ExecutionEditRequest",
]
