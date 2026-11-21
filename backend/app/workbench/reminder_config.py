"""工作台总览和库存通知共用的提醒配置。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet
from app.core.errors import Validation

REMINDER_CODE = "BUSINESS_OVERVIEW_REMINDERS"
DEFAULT_REMINDERS = {
    "inventory_aging_days": 7,
    "profit_notifications_enabled": True,
    "overdue_installments_enabled": True,
}


def read_reminder_config(session: Session) -> dict[str, Any]:
    row = session.scalar(select(OptionSet).where(OptionSet.code == REMINDER_CODE))
    values = {item.get("value"): item.get("label") for item in (row.options if row else [])}
    try:
        aging_days = int(values.get("inventory_aging_days", DEFAULT_REMINDERS["inventory_aging_days"]))
        if aging_days <= 0:
            raise ValueError
    except (TypeError, ValueError):
        aging_days = DEFAULT_REMINDERS["inventory_aging_days"]

    def enabled(key: str) -> bool:
        value = values.get(key)
        if value is None:
            return DEFAULT_REMINDERS[key]
        if value not in {"0", "1"}:
            raise Validation("业务提醒开关配置无效", details={"field": key})
        return value == "1"

    return {
        "inventory_aging_days": aging_days,
        "profit_notifications_enabled": enabled("profit_notifications_enabled"),
        "overdue_installments_enabled": enabled("overdue_installments_enabled"),
    }
