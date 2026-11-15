"""系统通知接口模型。"""
from __future__ import annotations

from datetime import datetime

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
    read_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class NotificationListOut(BaseModel):
    items: list[NotificationOut]
    total: int
    unread_total: int


class NotificationSummaryOut(BaseModel):
    unread_profit_total: int


__all__ = ["NotificationListOut", "NotificationOut", "NotificationSummaryOut"]
