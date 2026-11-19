"""工作台和经营中心共用的业务周期。"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.options import OptionSet

PERIOD_CONFIG_CODE = "BUSINESS_PERIOD"
DEFAULT_PERIOD_START_DAY = 16


def period_start_day(session: Session) -> int:
    row = session.scalar(select(OptionSet).where(OptionSet.code == PERIOD_CONFIG_CODE))
    try:
        day = int(next(item["label"] for item in (row.options if row else []) if item.get("value") == "start_day"))
        return day if 1 <= day <= 31 else DEFAULT_PERIOD_START_DAY
    except (StopIteration, TypeError, ValueError, KeyError):
        return DEFAULT_PERIOD_START_DAY


def business_period(today: date, start_day: int) -> tuple[date, date]:
    def start(year: int, month: int) -> date:
        return date(year, month, min(start_day, calendar.monthrange(year, month)[1]))

    start_this_month = start(today.year, today.month)
    if today < start_this_month:
        previous = today.replace(day=1) - timedelta(days=1)
        return start(previous.year, previous.month), start_this_month - timedelta(days=1)
    next_month = (today.replace(day=28) + timedelta(days=4)).replace(day=1)
    return start_this_month, start(next_month.year, next_month.month) - timedelta(days=1)
