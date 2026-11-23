"""core.errors：统一异常与错误码。

错误码与 HTTP 状态映射由本模块的 `AppError` 层级唯一决定，
业务代码只允许抛 `AppError` 子类，禁止在路由里手工拼 HTTPException 状态码。
"""
from __future__ import annotations

from typing import Any, Mapping


class ErrorCode:
    """错误码全集：新增码必须同步更新《接口错误码与状态机》文档。"""

    # 401 / 403
    AUTH_REQUIRED = "AUTH_REQUIRED"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    SESSION_INVALIDATED = "SESSION_INVALIDATED"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"

    # 404
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND"

    # 405
    METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"

    # 429
    RATE_LIMITED = "RATE_LIMITED"

    # 503
    RATE_LIMIT_STORE_UNAVAILABLE = "RATE_LIMIT_STORE_UNAVAILABLE"

    # 409
    ORDER_STATUS_CONFLICT = "ORDER_STATUS_CONFLICT"
    VERSION_CONFLICT = "VERSION_CONFLICT"
    FIELD_DEFINITION_HAS_VALUES = "FIELD_DEFINITION_HAS_VALUES"
    DUPLICATE_ATTACHMENT = "DUPLICATE_ATTACHMENT"

    # 422 — 通用与资金/主数据
    VALIDATION_ERROR = "VALIDATION_ERROR"
    POOL_ROUTE_MISSING = "POOL_ROUTE_MISSING"
    ZERO_PRINCIPAL_FORBIDDEN = "ZERO_PRINCIPAL_FORBIDDEN"
    POOL_DISABLED = "POOL_DISABLED"
    POOL_HAS_TRANSACTIONS = "POOL_HAS_TRANSACTIONS"
    POOL_CODE_IMMUTABLE = "POOL_CODE_IMMUTABLE"
    ORDER_TYPE_IMMUTABLE = "ORDER_TYPE_IMMUTABLE"
    ORDER_TYPE_DISABLED = "ORDER_TYPE_DISABLED"
    PARTICIPANT_ROLE_INVALID = "PARTICIPANT_ROLE_INVALID"
    CUSTOMER_DISABLED = "CUSTOMER_DISABLED"
    COUNTERPARTY_DISABLED = "COUNTERPARTY_DISABLED"
    INSTALLMENT_TYPE_INVALID = "INSTALLMENT_TYPE_INVALID"
    PAYMENT_EXCEEDS_RECEIVABLE = "PAYMENT_EXCEEDS_RECEIVABLE"
    DELIVERY_CONDITION_UNMET = "DELIVERY_CONDITION_UNMET"
    EVENT_CASHFLOW_EXISTS = "EVENT_CASHFLOW_EXISTS"
    MERGE_TARGET_INVALID = "MERGE_TARGET_INVALID"
    DUPLICATE_CODE = "DUPLICATE_CODE"
    # 建单判重：同一游戏账号+游戏类型已有库存。未售出直接拒绝，已售出需显式确认复购。
    INVENTORY_ACCOUNT_IN_STOCK = "INVENTORY_ACCOUNT_IN_STOCK"
    REPURCHASE_CONFIRM_REQUIRED = "REPURCHASE_CONFIRM_REQUIRED"
    AMOUNT_INVALID = "AMOUNT_INVALID"


class AppError(Exception):
    """所有业务异常的基类。

    details 只携带非敏感的排障字段（对象编号、期望值等），
    严禁放入手机号、微信号、账号密码等敏感信息（权限矩阵 §3）。
    """

    http_status: int = 422
    code: str = ErrorCode.VALIDATION_ERROR

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        http_status: int | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if http_status is not None:
            self.http_status = http_status
        self.details: dict[str, Any] = dict(details or {})

    def to_payload(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class AuthError(AppError):
    http_status = 401
    code = ErrorCode.AUTH_REQUIRED


class TokenExpired(AuthError):
    code = ErrorCode.TOKEN_EXPIRED


class PermissionDenied(AppError):
    http_status = 403
    code = ErrorCode.PERMISSION_DENIED


class NotFound(AppError):
    """越权对象也返回 404：避免泄露“资源是否存在”（权限矩阵 §3）。"""

    http_status = 404
    code = ErrorCode.RESOURCE_NOT_FOUND


class Conflict(AppError):
    http_status = 409
    code = ErrorCode.ORDER_STATUS_CONFLICT


class Validation(AppError):
    http_status = 422
    code = ErrorCode.VALIDATION_ERROR


class RateLimited(AppError):
    """登录等高频接口被限流（429）。"""

    http_status = 429
    code = ErrorCode.RATE_LIMITED


class RateLimitUnavailable(AppError):
    """无法验证共享限流状态时拒绝访问。"""

    http_status = 503
    code = ErrorCode.RATE_LIMIT_STORE_UNAVAILABLE


def require_condition(condition: bool, message: str, **kwargs: Any) -> None:
    """卫语句：条件不满足即按给定类型抛错，避免深层嵌套 if。"""
    if not condition:
        error_cls = kwargs.pop("error_cls", Validation)
        raise error_cls(message, **kwargs)


__all__ = [
    "AppError",
    "AuthError",
    "Conflict",
    "ErrorCode",
    "NotFound",
    "PermissionDenied",
    "RateLimited",
    "RateLimitUnavailable",
    "TokenExpired",
    "Validation",
    "require_condition",
]
