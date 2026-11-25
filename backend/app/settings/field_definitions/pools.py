"""资金账户主数据服务。"""
from __future__ import annotations
from collections.abc import Mapping
from typing import Any
from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session
from app.shared.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.security import CurrentUser
from app.domain.enums import AuditAction, PoolStatus, PoolType
from app.domain.foundation import Pool
from app.shared.form_values import set_extra_values
from app.shared.option_codes import allocate_option_code
from ._common import _UNSET, _get_pool_or_404, _normalize_pool_code, _required_name, _required_pool_type, _snapshot
# --------------------------------------------------------------------- 资金账户
def list_pools(session: Session, *, include_disabled: bool = True, user: CurrentUser | None = None) -> list[Pool]:
    stmt = select(Pool).order_by(Pool.id)
    if not include_disabled:
        stmt = stmt.where(Pool.status == PoolStatus.ACTIVE.value)
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        stmt = stmt.where(Pool.id.in_(sorted(user.pool_ids)))
    return list(session.scalars(stmt))
def get_pool_by_code(session: Session, code: str) -> Pool | None:
    return session.scalar(select(Pool).where(Pool.code == _normalize_pool_code(code)))
def get_default_pool(session: Session) -> Pool | None:
    """落账默认池：优先 `is_default` 且活动；否则回退到唯一活动池。"""
    marked = list(
        session.scalars(
            select(Pool).where(
                Pool.is_default.is_(True), Pool.status == PoolStatus.ACTIVE.value
            )
        )
    )
    if len(marked) == 1:
        return marked[0]
    active = list(
        session.scalars(select(Pool).where(Pool.status == PoolStatus.ACTIVE.value))
    )
    return active[0] if len(active) == 1 else None


def require_default_pool(session: Session) -> Pool:
    """未显式指定 pool_id 时的落账池（2026-11-17 删除业务↔池路由后）。"""
    pool = get_default_pool(session)
    if pool is None:
        active = list(
            session.scalars(select(Pool).where(Pool.status == PoolStatus.ACTIVE.value))
        )
        marked = [item.id for item in active if item.is_default]
        raise Validation(
            "未配置唯一的默认资金账户（is_default 或唯一活动池）",
            code=ErrorCode.POOL_ROUTE_MISSING,
            details={"active_pool_ids": [item.id for item in active], "default_pool_ids": marked},
        )
    return pool


def _switch_default_pool(session: Session, pool: Pool) -> None:
    """把 pool 设为唯一默认资金账户；其余池的 is_default 一并清掉。"""
    # 所有默认账户切换共享同一事务锁；等待后再查询，避免并发请求各自看到旧默认值。
    session.execute(select(func.pg_advisory_xact_lock(1212831572, 1)))
    for other in session.scalars(select(Pool).where(Pool.is_default.is_(True))):
        if other.id != pool.id:
            other.is_default = False
    # 唯一索引逐语句检查，须先清除旧标记，再写入新的默认账户。
    session.flush()
    pool.is_default = True


def create_pool(
    session: Session,
    *,
    name: str,
    actor: str,
    pool_type: str = PoolType.OTHER.value,
    is_default: bool = False,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Pool:
    """新增资金账户：新增池无需改代码（PRD §1.2）。"""
    normalized_name = _required_name(name, field="name")
    normalized = allocate_option_code(session, "fund-pool", "pool", list(session.scalars(select(Pool.code))))
    pool = Pool(
        code=normalized,
        name=normalized_name,
        pool_type=_required_pool_type(pool_type),
        status=PoolStatus.ACTIVE.value,
        is_default=False,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(pool)
    if is_default:
        _switch_default_pool(session, pool)
    session.flush()
    set_extra_values(
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
        after=_snapshot(pool, ("code", "name", "pool_type", "status", "is_default")),
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
    is_default: bool | None = None,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
) -> Pool:
    """V18：`code` 永久不可修改，只有显示名/备注/用途可更新。"""
    pool = _get_pool_or_404(session, pool_id)
    next_name = _required_name(name, field="name") if name is not None else pool.name
    next_pool_type = (
        _required_pool_type(pool_type) if pool_type is not None else pool.pool_type
    )
    before = _snapshot(pool, ("name", "note", "pool_type", "is_default"))
    if name is not None:
        pool.name = next_name
    if note is not None:
        pool.note = note
    if pool_type is not None:
        pool.pool_type = next_pool_type
    if is_default is not None:
        if is_default:
            _switch_default_pool(session, pool)
        else:
            pool.is_default = False
    pool.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        set_extra_values(
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
        after=_snapshot(pool, ("name", "note", "pool_type", "is_default")),
    )
    return pool
def set_pool_status(session: Session, pool_id: int, status: str, *, actor: str) -> Pool:
    """启用/停用；停用后禁止新增流水（V17 只允许停用不允许删除）。"""
    if status not in PoolStatus.values():
        raise Validation("资金账户状态取值非法", details={"status": status})
    # 与落账共享同一事务锁：等待未提交的写入结束，再读取最新状态。
    session.execute(select(func.pg_advisory_xact_lock(1212831573, pool_id)))
    pool = session.get(Pool, pool_id, populate_existing=True)
    if pool is None:
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
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
    """判断该池是否已产生资金流水；有流水则禁止物理删除（见 delete_pool）。

    `has_table` 为防御性兜底：正常库 cashflow 表恒存在，但在尚未建表的空库
    （如迁移前、极简测试会话）中直接查询会抛错，此时按「无流水」处理。
    """
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
            "该资金账户已产生流水，只能停用不能删除",
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
    # 同一账户的多个写入可以并行；状态切换须等所有写入事务结束。
    session.execute(select(func.pg_advisory_xact_lock_shared(1212831573, pool_id)))
    pool = session.get(Pool, pool_id, populate_existing=True)
    if pool is None:
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金账户 {pool.code} 已停用，不可用于新记录",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code},
        )
    return pool
