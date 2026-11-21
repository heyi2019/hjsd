"""系统通知接口模型。"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    notification_no: str
    recipient_user_id: int
    notification_type: str
    title: str
    message: str
    entity_type: str
    entity_id: str
    created_by: str
    read_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class NotificationListOut(BaseModel):
    items: list[NotificationOut]
    total: int
    unread_total: int


class NotificationInboxOut(BaseModel):
    items: list[NotificationOut]
    next_cursor: str | None


class ProfitAllocationDetailOut(BaseModel):
    id: int
    allocation_type: str | None
    user_name: str
    rate: Decimal
    amount: Decimal


class ProfitNotificationDetailOut(BaseModel):
    notification_id: int
    order_no: str
    order_type: str
    sale_amount: Decimal | None
    order_profit: Decimal
    game_type: str | None = None
    cost_amount: Decimal | None = None
    allocatable_profit: Decimal | None = None
    stock_no: str | None
    inventory_entry_at: datetime
    sold_at: datetime | None
    inventory_operator: str | None
    allocations: list[ProfitAllocationDetailOut] = Field(default_factory=list)


class PendingProfitOrderOut(BaseModel):
    order_no: str | None
    order_id: int | None


class NotificationReadRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=10)
    category: Literal["latest", "sale", "inventory"] | None = None


class NotificationReadOut(BaseModel):
    read_ids: list[int]
    read_at: datetime | None = None
    next_read_id: int | None = None


__all__ = ["NotificationListOut", "NotificationOut"]
