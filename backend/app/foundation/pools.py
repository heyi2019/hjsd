"""资金池主数据服务。"""
from __future__ import annotations
from collections.abc import Mapping
from typing import Any
from sqlalchemy import inspect, select
from sqlalchemy.orm import Session
from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.security import CurrentUser
from app.domain.enums import AuditAction, PoolOwnership, PoolStatus, PoolType
from app.domain.foundation import Pool
from app.parties import service as parties_service
from ._common import _UNSET, _get_pool_or_404, _normalize_pool_code, _required_name, _required_pool_type, _snapshot
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
    from app.domain.trade import Cashflow  # 局部导入：资金流水模型只在使用时加载
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
