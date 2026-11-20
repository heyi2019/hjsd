"""系统通知接口模型。"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict


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


class ProfitNotificationDetailOut(BaseModel):
    notification_id: int
    order_no: str
    order_type: str
    sale_amount: Decimal | None
    stock_no: str | None
    inventory_entry_at: datetime
    removed_at: datetime | None
    recovery_operator: str | None


__all__ = ["NotificationListOut", "NotificationOut"]
