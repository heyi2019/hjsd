"""Compare an editing snapshot with locked database values."""
from datetime import datetime
from decimal import Decimal, InvalidOperation

from app.core.errors import Conflict, ErrorCode, Validation


def check_expected(expected: dict[str, object], current: dict[str, object], label: str) -> None:
    if not expected or not expected.keys() <= current.keys():
        raise Validation(f"{label}的并发检查字段无效")
    for field, value in expected.items():
        actual = current[field]
        try:
            if isinstance(actual, datetime) and isinstance(value, str):
                value = datetime.fromisoformat(value)
            elif isinstance(actual, Decimal) and value is not None:
                value = Decimal(str(value))
        except (ValueError, InvalidOperation) as exc:
            raise Validation(f"{label}的并发检查字段无效", details={"field": field}) from exc
        if actual != value:
            raise Conflict(f"{label}已被其他人修改，请刷新后重试", code=ErrorCode.VERSION_CONFLICT, details={"field": field})
