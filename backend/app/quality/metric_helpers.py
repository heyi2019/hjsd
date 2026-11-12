"""质量指标共用的纯函数（日期区间、比率、池可见性过滤）。

从 service.py 逐字搬出；service.py 用具名导入直连，模块属性访问方式不变。
"""
from __future__ import annotations

from calendar import monthrange
from datetime import date
from typing import Any

from sqlalchemy import false

from app.core.errors import Validation


def _month_start(value: date) -> date:
    return value.replace(day=1)


def _month_end(value: date) -> date:
    return value.replace(day=monthrange(value.year, value.month)[1])


def _next_month(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


def _metric_months(
    from_date: date | None,
    to_date: date | None,
) -> list[date]:
    if from_date is not None and to_date is not None and from_date > to_date:
        raise Validation(
            "开始日期不能晚于结束日期",
            details={"from": from_date.isoformat(), "to": to_date.isoformat()},
        )
    start = _month_start(from_date or to_date or date.today())
    end = _month_start(to_date or from_date or date.today())
    result: list[date] = []
    cursor = start
    while cursor <= end:
        result.append(cursor)
        cursor = _next_month(cursor)
    return result


def _percentage(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return round(numerator * 100 / denominator, 2)


def _pool_column_filter(column: Any, pool_ids: tuple[int, ...]) -> Any:
    """池可见性过滤；空授权集合视为不可见任何池。"""
    return column.in_(pool_ids) if pool_ids else false()
