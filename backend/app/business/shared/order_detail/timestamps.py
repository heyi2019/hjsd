"""把业务日期与已记录的时间合成详情展示时间，不改动创建时间。"""
from datetime import date, datetime
from typing import Any


def business_timestamp(day: date, recorded: datetime) -> datetime:
    return recorded.replace(year=day.year, month=day.month, day=day.day)


def historical_sale_timestamp(event: Any) -> datetime | None:
    """读取导入时明确提供的售卖时刻；无效或与业务日期不符时不使用。"""
    value = (event.form_extra or {}).get("historical_sale_at")
    if event.event_type != "SELL" or not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value)
    except ValueError:
        return None
    return result if result.tzinfo is None and result.date() == event.occurred_on else None
