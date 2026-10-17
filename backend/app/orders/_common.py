"""orders 领域共用的输入校验。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.core.errors import Validation
from app.core.money import require_non_negative, require_positive


def _non_negative_money(value: Any, *, field: str) -> Decimal:
    try:
        return require_non_negative(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _positive_money(value: Any, *, field: str) -> Decimal:
    try:
        return require_positive(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _required_text(value: Any, *, field: str, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation(message, details={"field": field})
    return value.strip()


def _required_bool(value: object, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise Validation(f"{field} 必须为布尔值", details={"field": field})
    return value

