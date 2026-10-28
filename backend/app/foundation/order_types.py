"""业务类型与资金路由服务。"""
from __future__ import annotations
from typing import Any
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.numbering import ensure_sequence
from app.domain.enums import AuditAction, CapitalType, FundNature, PoolStatus, Portion
from app.domain.foundation import OrderTypeDef, OrderTypePool, Pool
from app.domain.trade import Cashflow, Order, OrderEvent
from ._common import SEQUENCE_PREFIX_PATTERN, _get_order_type_or_404, _non_negative_int, _normalize_code, _required_bool, _required_name, _snapshot
from .pools import require_pool_by_code
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
    capital_type: str,
    actor: str,
    sequence_prefix: str | None = None,
    sort_order: int = 0,
    description: str | None = None,
) -> OrderTypeDef:
    """BAS-02-02：新增业务只需建一行主数据，不改代码、不改表。"""
    normalized = _normalize_code(code, field_name="code")
    normalized_name = _required_name(name, field="name")
    if capital_type not in CapitalType.values():
        raise Validation(
            "capital_type 取值非法",
            details={"capital_type": capital_type, "allowed": CapitalType.values()},
        )
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
        capital_type=capital_type,
        sequence_prefix=prefix,
        sequence_key=sequence_key,
        is_active=False,  # BAS-02-02：启用前必须配置资金路由
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
        after=_snapshot(order_type, ("code", "name", "capital_type", "sequence_prefix")),
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
) -> OrderTypeDef:
    """BAS-02-03：code / capital_type / 编号前缀一旦使用即不可改。"""
    order_type = _get_order_type_or_404(session, order_type_id)
    if sort_order is not None:
        sort_order = _non_negative_int(sort_order, field="sort_order")
    if sort_order is not None and sort_order < 0:
        raise Validation(
            "排序值不能为负数",
            details={"field": "sort_order", "value": sort_order},
        )
    before = _snapshot(order_type, ("name", "description", "sort_order"))
    if name is not None:
        order_type.name = _required_name(name, field="name")
    if description is not None:
        order_type.description = description
    if sort_order is not None:
        order_type.sort_order = sort_order
    order_type.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_TYPE_UPDATE,
        entity_type="OrderTypeDef",
        entity_id=order_type.id,
        actor=actor,
        before=before,
        after=_snapshot(order_type, ("name", "description", "sort_order")),
    )
    return order_type
def set_order_type_active(
    session: Session, order_type_id: int, is_active: bool, *, actor: str
) -> OrderTypeDef:
    """启用前必须已配置资金路由（BAS-02-02 验收）。"""
    is_active = _required_bool(is_active, field="is_active")
    order_type = _get_order_type_or_404(session, order_type_id)
    if is_active:
        routes = list(
            session.scalars(
                select(OrderTypePool)
                .join(Pool, Pool.id == OrderTypePool.pool_id)
                .where(
                    OrderTypePool.order_type_id == order_type_id,
                    OrderTypePool.is_active.is_(True),
                    Pool.status == PoolStatus.ACTIVE.value,
                )
            )
        )
        if not routes:
            raise Validation(
                f"业务 {order_type.code} 尚未配置启用中的资金池路由，无法启用",
                code=ErrorCode.POOL_ROUTE_MISSING,
                details={"order_type": order_type.code},
            )
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
# ------------------------------------------------------------------- 资金路由
def list_routes(session: Session, *, order_type_id: int | None = None) -> list[OrderTypePool]:
    stmt = select(OrderTypePool).order_by(
        OrderTypePool.order_type_id, OrderTypePool.portion, OrderTypePool.fund_nature
    )
    if order_type_id is not None:
        stmt = stmt.where(OrderTypePool.order_type_id == order_type_id)
    return list(session.scalars(stmt))
def set_route(
    session: Session,
    *,
    order_type_code: str,
    portion: str,
    pool_code: str,
    actor: str,
    fund_nature: str | None = None,
    priority: int = 0,
    is_active: bool = True,
) -> OrderTypePool:
    """BAS-03-02：同一业务、份额和资金性质仅保留一条默认路由。"""
    is_active = _required_bool(is_active, field="is_active")
    if portion not in Portion.values():
        raise Validation(
            "portion 取值非法", details={"portion": portion, "allowed": Portion.values()}
        )
    if fund_nature is not None and fund_nature not in FundNature.values():
        raise Validation(
            "fund_nature 取值非法",
            details={"fund_nature": fund_nature, "allowed": FundNature.values()},
        )
    priority = _non_negative_int(priority, field="priority")
    if priority < 0:
        raise Validation(
            "优先级不能为负数",
            details={"field": "priority", "value": priority},
        )
    order_type = require_order_type_by_code(session, order_type_code)
    pool = require_pool_by_code(session, pool_code)
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不可作为路由目标",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code},
        )
    route = session.scalar(
        select(OrderTypePool).where(
            OrderTypePool.order_type_id == order_type.id,
            OrderTypePool.portion == portion,
            OrderTypePool.fund_nature == fund_nature,
        )
    )
    before = None
    if route is None:
        route = OrderTypePool(
            order_type_id=order_type.id,
            pool_id=pool.id,
            portion=portion,
            fund_nature=fund_nature,
            priority=priority,
            is_active=is_active,
        )
        session.add(route)
    else:
        before = _snapshot(route, ("pool_id", "priority", "is_active"))
        route.pool_id = pool.id
        route.priority = priority
        route.is_active = is_active
    session.flush()
    record_audit(
        session,
        action=AuditAction.ROUTE_UPDATE,
        entity_type="OrderTypePool",
        entity_id=route.id,
        actor=actor,
        before=before,
        after=_snapshot(route, ("pool_id", "priority", "is_active")),
        reason=f"{order_type.code}/{portion}/{fund_nature or '*'} -> {pool.code}",
    )
    return route
def route_impact_preview(
    session: Session,
    *,
    order_type_code: str,
    portion: str,
    pool_code: str,
    fund_nature: str | None = None,
) -> dict[str, Any]:
    """预览路由变更影响；只读，不改写历史订单或流水。"""
    if portion not in Portion.values():
        raise Validation(
            "portion 取值非法", details={"portion": portion, "allowed": Portion.values()}
        )
    if fund_nature is not None and fund_nature not in FundNature.values():
        raise Validation(
            "fund_nature 取值非法",
            details={"fund_nature": fund_nature, "allowed": FundNature.values()},
        )
    order_type = require_order_type_by_code(session, order_type_code)
    pool = require_pool_by_code(session, pool_code)
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不可作为路由目标",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code},
        )
    current = _find_route(
        session, order_type.id, portion, fund_nature=fund_nature, active_only=False
    )
    order_ids = list(
        session.scalars(
            select(Order.id).where(Order.order_type == order_type.code)
        ).all()
    )
    event_count = (
        session.scalar(
            select(func.count(OrderEvent.id)).where(OrderEvent.order_id.in_(order_ids))
        )
        if order_ids
        else 0
    )
    cashflow_count = (
        session.scalar(
            select(func.count(Cashflow.id)).where(Cashflow.order_id.in_(order_ids))
        )
        if order_ids
        else 0
    )
    return {
        "order_type": order_type.code,
        "portion": portion,
        "fund_nature": fund_nature,
        "current_route": {
            "pool_code": current.pool.code,
            "pool_name": current.pool.name,
            "priority": current.priority,
            "is_active": current.is_active,
        }
        if current is not None
        else None,
        "proposed_route": {
            "pool_code": pool.code,
            "pool_name": pool.name,
        },
        "changed": current is None or current.pool_id != pool.id,
        "historical_impact": {
            "order_count": len(order_ids),
            "event_count": int(event_count or 0),
            "cashflow_count": int(cashflow_count or 0),
            "unchanged": True,
        },
        "future_effect": "仅影响变更提交后按该业务和份额新解析的默认资金池，历史记录保留实际 pool_id",
    }
def resolve_default_pool(
    session: Session,
    order_type_code: str,
    portion: str,
    fund_nature: str | None = None,
) -> Pool | None:
    """读取默认资金池；资金性质路由优先，未配置时回退兼容旧份额路由。"""
    if portion not in Portion.values():
        raise Validation(
            "portion 取值非法", details={"portion": portion, "allowed": Portion.values()}
        )
    if fund_nature is not None and fund_nature not in FundNature.values():
        raise Validation(
            "fund_nature 取值非法",
            details={"fund_nature": fund_nature, "allowed": FundNature.values()},
        )
    order_type = get_order_type_by_code(session, order_type_code)
    if order_type is None:
        raise NotFound("业务类型不存在", details={"order_type_code": order_type_code})
    route = _find_route(
        session, order_type.id, portion, fund_nature=fund_nature, active_only=True
    )
    if route is None:
        return None
    return session.get(Pool, route.pool_id)
def require_default_pool(
    session: Session,
    order_type_code: str,
    portion: str,
    fund_nature: str | None = None,
) -> Pool:
    """路由优先级：显式池 > 业务默认路由 > 报错（PRD §1.3）。"""
    pool = resolve_default_pool(session, order_type_code, portion, fund_nature=fund_nature)
    if pool is None:
        raise Validation(
            f"业务 {order_type_code} 未配置 {portion}/{fund_nature or '*'} 资金池",
            code=ErrorCode.POOL_ROUTE_MISSING,
            details={
                "order_type": order_type_code,
                "portion": portion,
                "fund_nature": fund_nature,
            },
        )
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不可用于新记录",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code},
        )
    return pool


def _find_route(
    session: Session,
    order_type_id: int,
    portion: str,
    *,
    fund_nature: str | None,
    active_only: bool,
) -> OrderTypePool | None:
    """按资金性质优先查找路由，随后回退到旧版仅按份额的路由。"""
    base = [
        OrderTypePool.order_type_id == order_type_id,
        OrderTypePool.portion == portion,
    ]
    if active_only:
        base.append(OrderTypePool.is_active.is_(True))
    if fund_nature is not None:
        route = session.scalar(
            select(OrderTypePool).where(
                *base,
                OrderTypePool.fund_nature == fund_nature,
            )
        )
        if route is not None:
            return route
    return session.scalar(
        select(OrderTypePool).where(
            *base,
            OrderTypePool.fund_nature.is_(None),
        )
    )
