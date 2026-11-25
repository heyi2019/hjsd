"""工作台总览和库存通知共用的提醒配置（跨域共享原语）。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet
from app.core.errors import Validation
from app.shared.fixed_option_codes import REMINDER_CODE

DEFAULT_REMINDERS = {
    "inventory_aging_days": 7,
    "profit_notifications_enabled": True,
    "overdue_installments_enabled": True,
}
REMINDER_SWITCH_KEYS = frozenset({"profit_notifications_enabled", "overdue_installments_enabled"})


def _inventory_aging_days(value: object) -> int | None:
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        return None
    digits = value.lstrip("0")
    if not digits or len(digits) > 3:
        return None
    days = int(digits)
    return days if days <= 365 else None


def _enabled(key: str, value: str | None) -> bool:
    if value is None:
        return DEFAULT_REMINDERS[key]
    if value not in {"0", "1"}:
        raise Validation("业务提醒开关配置无效", details={"field": key})
    return value == "1"


def validate_reminder_options(options: list[dict[str, str]]) -> None:
    """拒绝保存无效的提醒开关和库存提醒天数。"""
    for option in options:
        if option["value"] in REMINDER_SWITCH_KEYS:
            _enabled(option["value"], option["label"])
        elif option["value"] == "inventory_aging_days" and _inventory_aging_days(option["label"]) is None:
            raise Validation("库存提醒天数必须为 1 至 365 的整数", details={"field": "inventory_aging_days"})


def read_reminder_config(session: Session) -> dict[str, Any]:
    row = session.scalar(select(OptionSet).where(OptionSet.code == REMINDER_CODE))
    values = {item.get("value"): item.get("label") for item in (row.options if row else [])}
    aging_days = _inventory_aging_days(values.get("inventory_aging_days"))
    if aging_days is None:
        aging_days = DEFAULT_REMINDERS["inventory_aging_days"]

    return {
        "inventory_aging_days": aging_days,
        "profit_notifications_enabled": _enabled("profit_notifications_enabled", values.get("profit_notifications_enabled")),
        "overdue_installments_enabled": _enabled("overdue_installments_enabled", values.get("overdue_installments_enabled")),
    }
