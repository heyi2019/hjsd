"""field_definitions.service：资金账户 / 业务类型 / 路由 / 编号序列的 Service 层。
所有写操作在同一个 Service 事务内完成：**业务落库 + 审计写盘**，失败整体回滚。
业务类型与资金账户都是主数据：新增业务/新增池不需要改代码、不改表（V32/V33）。
"""
from __future__ import annotations
import re
from collections.abc import Sequence
from typing import Any
from sqlalchemy.orm import Session
from app.core.errors import NotFound, Validation
from app.domain.foundation import OrderTypeDef, Pool
# 业务代码为紧凑大写字母数字（HS / TB2）。
ORDER_TYPE_CODE_PATTERN = re.compile(r"^[A-Z0-9]{2,10}$")
SEQUENCE_PREFIX_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{0,15}$")
_UNSET = object()
# --------------------------------------------------------------------- 内部工具
def _snapshot(obj: Any, fields: Sequence[str]) -> dict[str, Any]:
    return {name: getattr(obj, name, None) for name in fields}
def _normalize_code(
    value: object,
    *,
    field_name: str = "code",
    pattern: re.Pattern[str] = ORDER_TYPE_CODE_PATTERN,
    hint: str = "2-10 位大写字母或数字",
) -> str:
    code = value.strip().upper() if isinstance(value, str) else ""
    if not pattern.match(code):
        raise Validation(
            f"{field_name} 必须为 {hint}",
            details={"field": field_name, "value": value},
        )
    return code
def _normalize_pool_code(value: str) -> str:
    code = value.strip() if isinstance(value, str) else ""
    if not re.fullmatch(r"pool_\d{2,}", code):
        raise Validation("资金账户代码格式无效", details={"field": "code", "value": value})
    return code
def _required_name(value: str, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation("名称不能为空", details={"field": field})
    return value.strip()
def _required_pool_type(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation("pool_type 不能为空", details={"field": "pool_type"})
    return value.strip()
def _required_bool(value: object, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise Validation(f"{field} 必须为布尔值", details={"field": field})
    return value
def _non_negative_int(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise Validation(
            "排序值必须为非负整数" if field == "sort_order" else f"{field} 必须为非负整数",
            details={"field": field, "value": value},
        )
    return value
def _get_pool_or_404(session: Session, pool_id: int) -> Pool:
    pool = session.get(Pool, pool_id)
    if pool is None:
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    return pool
def _get_order_type_or_404(session: Session, order_type_id: int) -> OrderTypeDef:
    order_type = session.get(OrderTypeDef, order_type_id)
    if order_type is None:
        raise NotFound("业务类型不存在", details={"order_type_id": order_type_id})
    return order_type
