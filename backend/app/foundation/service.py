"""foundation.service：资金池 / 业务类型 / 路由 / 编号序列的 Service 层。

所有写操作在同一个 Service 事务内完成：**业务落库 + 审计写盘**，失败整体回滚。
业务类型与资金池都是主数据：新增业务/新增池不需要改代码、不改表（V32/V33）。
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.security import CurrentUser
from app.core.numbering import allocate_number, ensure_sequence, peek_number
from app.domain.enums import (
    AuditAction,
    CapitalType,
    PoolOwnership,
    PoolStatus,
    PoolType,
    Portion,
)
from app.domain.foundation import DocumentSequence, OrderTypeDef, OrderTypePool, Pool
from app.domain.trade import Cashflow, Order, OrderEvent
from app.parties import service as parties_service

# 池代码允许下划线（HJ_INVEST / HJ_PROFIT）；业务代码为紧凑大写字母数字（HS / TB2）
POOL_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
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
    return _normalize_code(
        value,
        pattern=POOL_CODE_PATTERN,
        hint="大写字母开头，可含数字与下划线（如 HJ_INVEST）",
    )


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
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    return pool


def _get_order_type_or_404(session: Session, order_type_id: int) -> OrderTypeDef:
    order_type = session.get(OrderTypeDef, order_type_id)
    if order_type is None:
        raise NotFound("业务类型不存在", details={"order_type_id": order_type_id})
    return order_type


# --------------------------------------------------------------------- 资金池
def list_pools(session: Session, *, include_disabled: bool = True, user: CurrentUser | None = None) -> list[Pool]:
    stmt = select(Pool).order_by(Pool.id)
    if not include_disabled:
        stmt = stmt.where(Pool.status == PoolStatus.ACTIVE.value)
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        stmt = stmt.where(Pool.id.in_(sorted(user.pool_ids)))
    return list(session.scalars(stmt))


def get_pool_by_code(session: Session, code: str) -> Pool | None:
    return session.scalar(select(Pool).where(Pool.code == _normalize_pool_code(code)))


def require_pool_by_code(session: Session, code: str) -> Pool:
    pool = get_pool_by_code(session, code)
    if pool is None:
        raise NotFound("资金池不存在", details={"pool_code": code})
    return pool


def create_pool(
    session: Session,
    *,
    code: str,
    name: str,
    actor: str,
    pool_type: str = PoolType.OTHER.value,
    ownership: str = PoolOwnership.OWNED.value,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Pool:
    """新增资金池：新增池无需改代码（PRD §1.2）。"""
    normalized = _normalize_pool_code(code)
    normalized_name = _required_name(name, field="name")
    if session.scalar(select(Pool).where(Pool.code == normalized)) is not None:
        raise Validation(
            f"资金池代码 {normalized} 已存在",
            code=ErrorCode.DUPLICATE_CODE,
            details={"code": normalized},
        )
    if ownership not in PoolOwnership.values():
        raise Validation(
            "ownership 取值非法", details={"ownership": ownership, "allowed": PoolOwnership.values()}
        )
    pool = Pool(
        code=normalized,
        name=normalized_name,
        pool_type=_required_pool_type(pool_type),
        ownership=ownership,
        status=PoolStatus.ACTIVE.value,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(pool)
    session.flush()
    parties_service.set_extra_values(
        session,
        entity_type="pool",
        entity_id=pool.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.POOL_CREATE,
        entity_type="Pool",
        entity_id=pool.id,
        actor=actor,
        after=_snapshot(pool, ("code", "name", "pool_type", "ownership", "status")),
    )
    return pool


def update_pool(
    session: Session,
    pool_id: int,
    *,
    actor: str,
    name: str | None = None,
    note: str | None = None,
    pool_type: str | None = None,
    ownership: str | None = None,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
) -> Pool:
    """V18：`code` 永久不可修改，只有显示名/备注/用途/归属可更新。"""
    pool = _get_pool_or_404(session, pool_id)
    next_name = _required_name(name, field="name") if name is not None else pool.name
    next_pool_type = (
        _required_pool_type(pool_type) if pool_type is not None else pool.pool_type
    )
    next_ownership = ownership if ownership is not None else pool.ownership
    if next_ownership not in PoolOwnership.values():
        raise Validation("ownership 取值非法", details={"ownership": next_ownership})

    before = _snapshot(pool, ("name", "note", "pool_type", "ownership"))
    if name is not None:
        pool.name = next_name
    if note is not None:
        pool.note = note
    if pool_type is not None:
        pool.pool_type = next_pool_type
    if ownership is not None:
        pool.ownership = next_ownership
    pool.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        parties_service.set_extra_values(
            session,
            entity_type="pool",
            entity_id=pool.id,
            values=(extra_values or {}).items(),
        )
    record_audit(
        session,
        action=AuditAction.POOL_UPDATE,
        entity_type="Pool",
        entity_id=pool.id,
        actor=actor,
        before=before,
        after=_snapshot(pool, ("name", "note", "pool_type", "ownership")),
    )
    return pool


def set_pool_status(session: Session, pool_id: int, status: str, *, actor: str) -> Pool:
    """启用/停用；停用后禁止新增流水（V17 只允许停用不允许删除）。"""
    if status not in PoolStatus.values():
        raise Validation("资金池状态取值非法", details={"status": status})
    pool = _get_pool_or_404(session, pool_id)
    before = _snapshot(pool, ("status",))
    pool.status = status
    pool.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.POOL_DISABLE,
        entity_type="Pool",
        entity_id=pool.id,
        actor=actor,
        before=before,
        after=_snapshot(pool, ("status",)),
    )
    return pool


def _has_cashflow(session: Session, pool_id: int) -> bool:
    """判断该池是否已产生资金流水（M0 阶段 `cashflow` 表尚未创建）。"""
    bind = session.get_bind()
    if not inspect(bind).has_table("cashflow"):
        return False
    from sqlalchemy import func as sa_func

    from app.domain.trade import Cashflow  # 局部导入：M0 阶段该表由 0002 迁移建立

    count = session.scalar(
        select(sa_func.count()).select_from(Cashflow).where(Cashflow.pool_id == pool_id)
    )
    return bool(count)


def delete_pool(session: Session, pool_id: int, *, actor: str) -> None:
    """V17：有流水的池禁止物理删除，只能停用。"""
    pool = _get_pool_or_404(session, pool_id)
    if _has_cashflow(session, pool_id):
        raise Validation(
            "该资金池已产生流水，只能停用不能删除",
            code=ErrorCode.POOL_HAS_TRANSACTIONS,
            details={"pool_id": pool_id, "pool_code": pool.code},
        )
    before = _snapshot(pool, ("code", "name", "status"))
    session.delete(pool)
    session.flush()
    record_audit(
        session,
        action=AuditAction.POOL_DELETE,
        entity_type="Pool",
        entity_id=pool_id,
        actor=actor,
        before=before,
    )


def assert_pool_usable(session: Session, pool_id: int) -> Pool:
    """写入前的池校验：存在、启用；停用池不得承接新流水。"""
    pool = _get_pool_or_404(session, pool_id)
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不可用于新记录",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code},
        )
    return pool


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
    stmt = select(OrderTypePool).order_by(OrderTypePool.order_type_id, OrderTypePool.portion)
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
    priority: int = 0,
    is_active: bool = True,
) -> OrderTypePool:
    """BAS-03-02：同一业务同一份额仅保留一条默认路由（幂等覆盖）。"""
    is_active = _required_bool(is_active, field="is_active")
    if portion not in Portion.values():
        raise Validation(
            "portion 取值非法", details={"portion": portion, "allowed": Portion.values()}
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
        )
    )
    before = None
    if route is None:
        route = OrderTypePool(
            order_type_id=order_type.id,
            pool_id=pool.id,
            portion=portion,
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
        reason=f"{order_type.code}/{portion} -> {pool.code}",
    )
    return route


def route_impact_preview(
    session: Session,
    *,
    order_type_code: str,
    portion: str,
    pool_code: str,
) -> dict[str, Any]:
    """预览路由变更影响；只读，不改写历史订单或流水。"""
    if portion not in Portion.values():
        raise Validation(
            "portion 取值非法", details={"portion": portion, "allowed": Portion.values()}
        )
    order_type = require_order_type_by_code(session, order_type_code)
    pool = require_pool_by_code(session, pool_code)
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不可作为路由目标",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code},
        )
    current = session.scalar(
        select(OrderTypePool)
        .where(
            OrderTypePool.order_type_id == order_type.id,
            OrderTypePool.portion == portion,
        )
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


def resolve_default_pool(session: Session, order_type_code: str, portion: str) -> Pool | None:
    """读取默认资金池（不抛错），供上层决定是否需要显式覆盖。"""
    if portion not in Portion.values():
        raise Validation(
            "portion 取值非法", details={"portion": portion, "allowed": Portion.values()}
        )
    order_type = get_order_type_by_code(session, order_type_code)
    if order_type is None:
        raise NotFound("业务类型不存在", details={"order_type_code": order_type_code})
    route = session.scalar(
        select(OrderTypePool).where(
            OrderTypePool.order_type_id == order_type.id,
            OrderTypePool.portion == portion,
            OrderTypePool.is_active.is_(True),
        )
    )
    if route is None:
        return None
    return session.get(Pool, route.pool_id)


def require_default_pool(session: Session, order_type_code: str, portion: str) -> Pool:
    """路由优先级：显式池 > 业务默认路由 > 报错（PRD §1.3）。"""
    pool = resolve_default_pool(session, order_type_code, portion)
    if pool is None:
        raise Validation(
            f"业务 {order_type_code} 未配置 {portion} 资金池",
            code=ErrorCode.POOL_ROUTE_MISSING,
            details={"order_type": order_type_code, "portion": portion},
        )
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不可用于新记录",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code},
        )
    return pool


# ----------------------------------------------------------------------- 编号
def ensure_order_sequence(session: Session, order_type: OrderTypeDef) -> DocumentSequence:
    return ensure_sequence(session, order_type.sequence_key, order_type.sequence_prefix, 4)


def next_order_no(session: Session, order_type: OrderTypeDef) -> str:
    """按业务独立递增分配 `HS0001` / `TH0001` 之类编号。"""
    return allocate_number(session, order_type.sequence_key)


def preview_order_no(session: Session, order_type: OrderTypeDef) -> str:
    return peek_number(session, order_type.sequence_key)


def list_sequences(session: Session) -> list[DocumentSequence]:
    return list(session.scalars(select(DocumentSequence).order_by(DocumentSequence.sequence_key)))


__all__ = [
    "assert_pool_usable",
    "create_order_type",
    "create_pool",
    "delete_pool",
    "ensure_order_sequence",
    "get_order_type_by_code",
    "get_pool_by_code",
    "list_order_types",
    "list_pools",
    "list_routes",
    "list_sequences",
    "next_order_no",
    "preview_order_no",
    "require_default_pool",
    "require_order_type_by_code",
    "require_pool_by_code",
    "resolve_default_pool",
    "route_impact_preview",
    "set_order_type_active",
    "set_pool_status",
    "set_route",
    "update_order_type",
    "update_pool",
]
