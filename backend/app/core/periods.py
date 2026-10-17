"""会计期间锁定的统一写入守卫（FIN-05-02）。"""
from __future__ import annotations

import re
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, ErrorCode, Validation
from app.domain.foundation import PeriodLock

PERIOD_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def normalize_period(value: str) -> str:
    period = value.strip()
    if not PERIOD_PATTERN.fullmatch(period):
        raise Validation(
            "账期必须使用 YYYY-MM 格式",
            details={"field": "period", "value": value},
        )
    return period


def period_of(value: date) -> str:
    return value.strftime("%Y-%m")


def assert_period_open(
    session: Session,
    occurred_on: date,
    *,
    operation: str,
) -> None:
    period = period_of(occurred_on)
    lock = session.scalar(select(PeriodLock).where(PeriodLock.period == period))
    if lock is not None:
        raise Conflict(
            f"账期 {period} 已锁定，不能{operation}",
            code=ErrorCode.PERIOD_LOCKED,
            details={"period": period, "locked_by": lock.locked_by},
        )


__all__ = ["assert_period_open", "normalize_period", "period_of"]
