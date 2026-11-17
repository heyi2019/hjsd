"""业务类型主数据服务（资金账户由 pools.get_default_pool 统一解析）。"""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.numbering import ensure_sequence
from app.domain.enums import AuditAction
from app.domain.foundation import OrderTypeDef
from ._common import SEQUENCE_PREFIX_PATTERN, _get_order_type_or_404, _non_negative_int, _normalize_code, _required_bool, _required_name, _snapshot
# ------------------------------------------------------------------ 业务类型
def list_order_types(session: Session, *, include_inactive: bool = True) -> list[OrderTypeDef]:
    stmt = select(OrderTypeDef).order_by(OrderTypeDef.sort_order, OrderTypeDef.id)
    if not include_inactive:
        stmt = stmt.where(OrderTypeDef.is_active.is_(True))
    return list(session.scalars(stmt))
def get_order_type_by_code(session: Session, code: str) -> OrderTypeDef | None:
    return session.scalar(select(OrderTypeDef).where(OrderTypeDef.code == _normalize_code(code)))
def require_order_type_by_code(session: Session, code: str) -> OrderTypeDef:
    order_type = get_order_type_by_code(session, code)
    if order_type is None:
        raise NotFound("业务类型不存在", details={"order_type_code": code})
    return order_type
def create_order_type(
    session: Session,
    *,
    code: str,
    name: str,
    actor: str,
    is_zero_principal: bool = False,
    sequence_prefix: str | None = None,
    sort_order: int = 0,
    description: str | None = None,
) -> OrderTypeDef:
    """BAS-02-02：新增业务只需建一行主数据，不改代码、不改表。"""
    normalized = _normalize_code(code, field_name="code")
    normalized_name = _required_name(name, field="name")
    is_zero_principal = _required_bool(is_zero_principal, field="is_zero_principal")
    sort_order = _non_negative_int(sort_order, field="sort_order")
    if sort_order < 0:
        raise Validation(
            "排序值不能为负数",
            details={"field": "sort_order", "value": sort_order},
        )
    if session.scalar(select(OrderTypeDef).where(OrderTypeDef.code == normalized)) is not None:
        raise Validation(
            f"业务代码 {normalized} 已存在",
            code=ErrorCode.DUPLICATE_CODE,
            details={"code": normalized},
        )
    if sequence_prefix is not None and not isinstance(sequence_prefix, str):
        raise Validation(
            "编号前缀必须为 1-16 位大写字母或数字，且以字母开头",
            details={"field": "sequence_prefix", "value": sequence_prefix},
        )
    prefix = (sequence_prefix or normalized).strip().upper()
    if not SEQUENCE_PREFIX_PATTERN.fullmatch(prefix):
        raise Validation(
            "编号前缀必须为 1-16 位大写字母或数字，且以字母开头",
            details={"field": "sequence_prefix", "value": sequence_prefix},
        )
    if session.scalar(
        select(OrderTypeDef.id).where(OrderTypeDef.sequence_prefix == prefix)
    ) is not None:
        raise Validation(f"编号前缀 {prefix} 已存在", details={"sequence_prefix": prefix})
    # 编号域随业务动态生成（如 TB -> ORDER_TB），不要求进入封闭枚举
    sequence_key = f"ORDER_{normalized}"
    order_type = OrderTypeDef(
        code=normalized,
        name=normalized_name,
        is_zero_principal=is_zero_principal,
        sequence_prefix=prefix,
        sequence_key=sequence_key,
        is_active=True,  # 2026-11-17 删除路由后，新建业务即可用（不再需要先配路由）
        sort_order=sort_order,
        description=description,
        created_by=actor,
        updated_by=actor,
    )
    session.add(order_type)
    session.flush()
    ensure_sequence(session, sequence_key, prefix, 4)
    record_audit(
        session,
        action=AuditAction.ORDER_TYPE_CREATE,
        entity_type="OrderTypeDef",
        entity_id=order_type.id,
        actor=actor,
        after=_snapshot(order_type, ("code", "name", "is_zero_principal", "sequence_prefix")),
    )
    return order_type
def update_order_type(
    session: Session,
    order_type_id: int,
    *,
    actor: str,
    name: str | None = None,
    description: str | None = None,
    sort_order: int | None = None,
    is_zero_principal: bool | None = None,
) -> OrderTypeDef:
    """BAS-02-03：code / 编号前缀一旦使用即不可改。"""
    order_type = _get_order_type_or_404(session, order_type_id)
    if sort_order is not None:
        sort_order = _non_negative_int(sort_order, field="sort_order")
    if sort_order is not None and sort_order < 0:
        raise Validation(
            "排序值不能为负数",
            details={"field": "sort_order", "value": sort_order},
        )
    before = _snapshot(order_type, ("name", "description", "sort_order", "is_zero_principal"))
    if name is not None:
        order_type.name = _required_name(name, field="name")
    if description is not None:
        order_type.description = description
    if sort_order is not None:
        order_type.sort_order = sort_order
    if is_zero_principal is not None:
        order_type.is_zero_principal = _required_bool(
            is_zero_principal, field="is_zero_principal"
        )
    order_type.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_TYPE_UPDATE,
        entity_type="OrderTypeDef",
        entity_id=order_type.id,
        actor=actor,
        before=before,
        after=_snapshot(order_type, ("name", "description", "sort_order", "is_zero_principal")),
    )
    return order_type
def set_order_type_active(
    session: Session, order_type_id: int, is_active: bool, *, actor: str
) -> OrderTypeDef:
    """启用/停用业务类型；新建业务无需额外配置资金账户路由。"""
    is_active = _required_bool(is_active, field="is_active")
    order_type = _get_order_type_or_404(session, order_type_id)
    before = _snapshot(order_type, ("is_active",))
    order_type.is_active = is_active
    order_type.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_TYPE_DISABLE,
        entity_type="OrderTypeDef",
        entity_id=order_type.id,
        actor=actor,
        before=before,
        after=_snapshot(order_type, ("is_active",)),
    )
    return order_type
