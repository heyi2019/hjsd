"""finance 领域共用的输入校验。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.core.errors import Validation
from app.core.money import require_non_negative, require_positive


def _non_negative(value: Any, *, field: str) -> Decimal:
    try:
        return require_non_negative(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _positive(value: Any, *, field: str) -> Decimal:
    try:
        return require_positive(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _text(
    value: Any,
    *,
    field: str,
    message: str,
    required: bool = True,
    uppercase: bool = False,
    type_message: str | None = None,
) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise Validation(type_message or f"{field} 必须为文本", details={"field": field})
    text = value.strip()
    if required and not text:
        raise Validation(message, details={"field": field})
    return text.upper() if uppercase else text

