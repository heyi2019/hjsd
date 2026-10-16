"""policy：经营规则定义 / 版本 / 审批 / 生效期解析（T19 / T20，BAS-06-01~04）。

红线（BAS-06-02 / BAS-06-04）：
1. **已被引用的版本不可修改/删除** —— 只能新建版本；
2. **同范围的新版本不得与已有版本有效期重叠**；
3. **已发生的业务不因规则改版而变化** —— 靠 `resolve_version` 返回
   「当时生效的版本」+ 业务对象上的 `policy_snapshot` 固化实现；
4. 发布只影响 `effective_from` 之后**新建**的业务，不重算历史。

有效期模型：`[effective_from, effective_to)` 左闭右开，NULL 表示至今。
这样相邻版本（前者 to = 次者 from）不重叠且无空隙。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.domain.enums import (
    AuditAction,
    PolicyScopeType,
    PolicyStatus,
)
from app.domain.parties import PolicyDefinition, PolicyVersion
from app.domain.trade import Order, OrderProfitAllocation
from app.core.security import CurrentUser


def _scoped_order(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> Order:
    """策略相关订单读写必须复用订单统一的负责人范围规则。"""
    from app.orders import service as orders_service

    return orders_service.get_order(session, order_id, user)


def _def_out(item: PolicyDefinition) -> dict[str, Any]:
    return {
        "id": item.id,
        "policy_code": item.policy_code,
        "name": item.name,
        "scope_type": item.scope_type,
        "scope_id": item.scope_id,
        "description": item.description,
        "status": item.status,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


def _ver_out(item: PolicyVersion) -> dict[str, Any]:
    return {
        "id": item.id,
        "policy_definition_id": item.policy_definition_id,
        "version": item.version,
        "effective_from": item.effective_from.isoformat() if item.effective_from else None,
        "effective_to": item.effective_to.isoformat() if item.effective_to else None,
        "config": item.config,
        "status": item.status,
        "approved_by": item.approved_by,
        "approved_at": item.approved_at.isoformat() if item.approved_at else None,
        "note": item.note,
    }


# ── T19 / BAS-06-01：规则定义 ───────────────────────────────────

def list_definitions(
    session: Session,
    *,
    status: str | None = None,
    policy_code: str | None = None,
) -> list[dict[str, Any]]:
    stmt = select(PolicyDefinition).order_by(PolicyDefinition.id)
    if status:
        stmt = stmt.where(PolicyDefinition.status == status.upper())
    if policy_code:
        stmt = stmt.where(PolicyDefinition.policy_code == policy_code.upper())
    return [_def_out(item) for item in session.scalars(stmt).all()]


def get_definition(session: Session, definition_id: int) -> dict[str, Any]:
    item = session.get(PolicyDefinition, definition_id)
    if item is None:
        raise NotFound(f"规则 {definition_id} 不存在", details={"definition_id": definition_id})
    return _def_out(item)


def create_definition(
    session: Session,
    *,
    policy_code: str,
    name: str,
    scope_type: str,
    scope_id: int | None = None,
    description: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    code = (policy_code or "").strip().upper()
    label = (name or "").strip()
    if not code:
        raise Validation("policy_code 不能为空", details={"field": "policy_code"})
    if not label:
        raise Validation("name 不能为空", details={"field": "name"})
    try:
        scope = PolicyScopeType(scope_type.upper())
    except ValueError as exc:
        raise Validation(
            f"scope_type 非法：{scope_type}",
            details={"field": "scope_type", "allowed": [s.value for s in PolicyScopeType]},
        ) from exc
    # 非全局范围必须指定 scope_id，否则规则会误伤全部业务
    if scope is not PolicyScopeType.GLOBAL and scope_id is None:
        raise Validation(
            f"{scope.value} 范围必须指定 scope_id",
            details={"field": "scope_id", "scope_type": scope.value},
        )

    exists = session.scalar(
        select(PolicyDefinition.id).where(PolicyDefinition.policy_code == code)
    )
    if exists:
        raise Validation(
            f"规则编码已存在：{code}", details={"policy_code": code, "id": exists}
        )

    item = PolicyDefinition(
        policy_code=code,
        name=label,
        scope_type=scope.value,
        scope_id=scope_id,
        description=description,
        status=PolicyStatus.DRAFT.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    record_audit(
        session,
        action=AuditAction.EXCEPTION_APPROVE,
        entity_type="policy_definition",
        entity_id=item.id,
        actor=actor,
        after=_def_out(item),
    )
    return _def_out(item)


# ── T19 / BAS-06-02：版本 + 生效期 + 审批 ────────────────────────

def _overlaps(
    session: Session,
    definition_id: int,
    start: date,
    end: date | None,
    *,
    exclude_version_id: int | None = None,
) -> PolicyVersion | None:
    """找出与 [start, end) 重叠的已有版本。

    区间重叠判定：a.start < b.end AND b.start < a.end；
    NULL 结束日视为至今（用极大值代替）。
    """
    far = date(9999, 12, 31)
    stmt = select(PolicyVersion).where(PolicyVersion.policy_definition_id == definition_id)
    if exclude_version_id is not None:
        stmt = stmt.where(PolicyVersion.id != exclude_version_id)
    for item in session.scalars(stmt).all():
        other_start = item.effective_from
        other_end = item.effective_to or far
        if start < other_end and other_start < (end or far):
            return item
    return None


def list_versions(
    session: Session, definition_id: int, *, status: str | None = None
) -> list[dict[str, Any]]:
    if session.get(PolicyDefinition, definition_id) is None:
        raise NotFound(f"规则 {definition_id} 不存在", details={"definition_id": definition_id})
    stmt = select(PolicyVersion).where(PolicyVersion.policy_definition_id == definition_id)
    if status:
        stmt = stmt.where(PolicyVersion.status == status.upper())
    stmt = stmt.order_by(PolicyVersion.version.desc())
    return [_ver_out(item) for item in session.scalars(stmt).all()]


def create_version(
    session: Session,
    definition_id: int,
    *,
    effective_from: date,
    effective_to: date | None = None,
    config: dict[str, Any],
    note: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    """新建版本。**不修改已有版本** —— 已发布版本不可变（BAS-06-02）。"""
    definition = session.get(PolicyDefinition, definition_id)
    if definition is None:
        raise NotFound(f"规则 {definition_id} 不存在", details={"definition_id": definition_id})
    if not config:
        raise Validation("规则参数不能为空", details={"field": "config"})
    if effective_to is not None and effective_to <= effective_from:
        raise Validation(
            "失效日期必须晚于生效日期",
            details={"effective_from": str(effective_from), "effective_to": str(effective_to)},
        )

    conflict = _overlaps(session, definition_id, effective_from, effective_to)
    if conflict is not None:
        raise Validation(
            "生效期与已有版本重叠",
            details={
                "conflict_version": conflict.version,
                "conflict_from": conflict.effective_from.isoformat(),
                "conflict_to": conflict.effective_to.isoformat() if conflict.effective_to else None,
            },
        )

    next_version = int(
        session.scalar(
            select(func.coalesce(func.max(PolicyVersion.version), 0)).where(
                PolicyVersion.policy_definition_id == definition_id
            )
        )
        or 0
    ) + 1
    item = PolicyVersion(
        policy_definition_id=definition_id,
        version=next_version,
        effective_from=effective_from,
        effective_to=effective_to,
        config=config,
        status=PolicyStatus.DRAFT.value,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    record_audit(
        session,
        action=AuditAction.EXCEPTION_APPROVE,
        entity_type="policy_version",
        entity_id=item.id,
        actor=actor,
        after=_ver_out(item),
    )
    return _ver_out(item)


def approve_version(
    session: Session, version_id: int, *, approver: str, note: str | None = None
) -> dict[str, Any]:
    """发布版本：生效后只影响新建业务，不回算历史（BAS-06-02 验收）。"""
    item = session.get(PolicyVersion, version_id)
    if item is None:
        raise NotFound(f"规则版本 {version_id} 不存在", details={"version_id": version_id})
    if item.status == PolicyStatus.ACTIVE.value:
        raise Validation("版本已发布，不可重复发布", details={"version_id": version_id})
    if not (approver or "").strip():
        raise Validation("必须记录审批人", details={"field": "approver"})

    before = {"status": item.status}
    item.status = PolicyStatus.ACTIVE.value
    item.approved_by = approver
    item.approved_at = datetime.now()
    if note:
        item.note = note
    session.flush()
    record_audit(
        session,
        action=AuditAction.POLICY_CHANGE,
        entity_type="policy_version",
        entity_id=item.id,
        actor=approver,
        before=before,
        after={"status": item.status, "approved_by": approver},
    )
    return _ver_out(item)


def update_version_draft(
    session: Session, version_id: int, *, config: dict[str, Any], actor: str = "system"
) -> dict[str, Any]:
    """只允许改**未发布**的草稿版本。已发布版本一律拒绝（BAS-06-02）。"""
    item = session.get(PolicyVersion, version_id)
    if item is None:
        raise NotFound(f"规则版本 {version_id} 不存在", details={"version_id": version_id})
    if item.status != PolicyStatus.DRAFT.value:
        raise Validation(
            "已发布/已失效的版本不可修改，请新建版本",
            details={"version_id": version_id, "status": item.status},
        )
    if not config:
        raise Validation("规则参数不能为空", details={"field": "config"})
    before = {"config": item.config}
    item.config = config
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.EXCEPTION_APPROVE,
        entity_type="policy_version",
        entity_id=item.id,
        actor=actor,
        before=before,
        after={"config": config},
    )
    return _ver_out(item)


# ── T20 / BAS-06-04：生效期解析 + 快照固化 ───────────────────────

def resolve_version(
    session: Session,
    *,
    policy_code: str,
    on: date,
    scope_type: str = PolicyScopeType.GLOBAL.value,
    scope_id: int | None = None,
) -> PolicyVersion | None:
    """取某日期上生效的版本。

    优先级：范围越具体越优先（USER > POOL > ORDER_TYPE > GLOBAL），
    同范围内取生效日期最新且不早于 on 的版本。
    """
    definition = session.scalar(
        select(PolicyDefinition).where(PolicyDefinition.policy_code == policy_code.upper())
    )
    if definition is None:
        return None
    far = date(9999, 12, 31)
    stmt = (
        select(PolicyVersion)
        .where(PolicyVersion.policy_definition_id == definition.id)
        .where(PolicyVersion.status == PolicyStatus.ACTIVE.value)
        .where(PolicyVersion.effective_from <= on)
    )
    rows = [
        item
        for item in session.scalars(stmt).all()
        if (item.effective_to or far) > on
    ]
    if not rows:
        return None
    rows.sort(key=lambda v: (v.effective_from, v.version), reverse=True)
    return rows[0]


def make_snapshot(
    session: Session, *, policy_code: str, on: date
) -> tuple[int | None, dict[str, Any] | None]:
    """生成规则快照：命中已发布版本则固化 version_id + 参数副本；未命中返回 (None, None)。

    刻意**深拷贝** config：调用方后续改动内存里的 dict 不能影响已固化的快照。
    """
    version = resolve_version(session, policy_code=policy_code, on=on)
    if version is None:
        return None, None
    snapshot = {
        "policy_code": policy_code.upper(),
        "version_id": version.id,
        "version": version.version,
        "effective_from": version.effective_from.isoformat(),
        "config": dict(version.config or {}),
        "captured_at": datetime.now().isoformat(),
    }
    return version.id, snapshot


def snapshot_for(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> dict[str, Any] | None:
    order = _scoped_order(session, order_id, user)
    if order.policy_snapshot is None:
        return None
    return {
        "policy_version_id": order.policy_version_id,
        "policy_snapshot": order.policy_snapshot,
    }


# ── T20 / BAS-06-03：订单多人利润分配 ────────────────────────────

def set_allocations(
    session: Session,
    order_id: int,
    *,
    items: list[dict[str, Any]],
    actor: str = "system",
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    """整单重设利润分配。**有效比例合计必须为 100%**（BAS-06-03）。"""
    order = _scoped_order(session, order_id, user)
    if not items:
        raise Validation("利润分配不能为空", details={"field": "items"})

    total = Decimal("0")
    seen: set[tuple[int, str]] = set()
    for item in items:
        try:
            rate = to_money(item.get("allocation_rate"))
        except (ValueError, ArithmeticError) as exc:
            raise Validation(
                "分配比例必须是数值",
                details={"field": "allocation_rate", "value": item.get("allocation_rate")},
            ) from exc
        if rate < 0:
            raise Validation("分配比例不得为负", details={"allocation_rate": str(rate)})
        total += rate
        key = (int(item["user_id"]), str(item["role"]).upper())
        if key in seen:
            raise Validation(
                "同一人员同一角色不可重复分配",
                details={"user_id": key[0], "role": key[1]},
            )
        seen.add(key)

    if total != Decimal("100.00"):
        raise Validation(
            "有效分配比例合计必须为 100%",
            details={"total": str(total), "items": len(items)},
        )

    # 整单重设：先清后写，避免残留旧比例
    for old in session.scalars(
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order_id)
    ).all():
        session.delete(old)
    session.flush()

    created = []
    for item in items:
        row = OrderProfitAllocation(
            order_id=order_id,
            user_id=int(item["user_id"]),
            role=str(item["role"]).upper(),
            allocation_rate=to_money(item.get("allocation_rate")),
            policy_version_id=order.policy_version_id,
        )
        session.add(row)
        created.append(row)
    session.flush()
    record_audit(
        session,
        action=AuditAction.EXCEPTION_APPROVE,
        entity_type="order",
        entity_id=order_id,
        actor=actor,
        after={
            "allocations": [
                {"user_id": r.user_id, "role": r.role, "rate": str(r.allocation_rate)}
                for r in created
            ]
        },
    )
    return list_allocations(session, order_id, user=user)


def list_allocations(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> list[dict[str, Any]]:
    _scoped_order(session, order_id, user)
    rows = session.scalars(
        select(OrderProfitAllocation)
        .where(OrderProfitAllocation.order_id == order_id)
        .order_by(OrderProfitAllocation.id)
    ).all()
    total = Decimal("0")
    out = []
    for row in rows:
        total += to_money(row.allocation_rate)
        out.append(
            {
                "id": row.id,
                "order_id": row.order_id,
                "user_id": row.user_id,
                "role": row.role,
                "allocation_rate": str(to_money(row.allocation_rate)),
                "policy_version_id": row.policy_version_id,
            }
        )
    return [{**item, "total_rate": str(total)} for item in out] if out else []


__all__ = [
    "approve_version",
    "create_definition",
    "create_version",
    "get_definition",
    "list_allocations",
    "list_definitions",
    "list_versions",
    "make_snapshot",
    "resolve_version",
    "set_allocations",
    "snapshot_for",
    "update_version_draft",
]
