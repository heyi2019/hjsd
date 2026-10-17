"""资金池实际账户：账户主数据与启停管理。"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.money import to_money
from app.domain.foundation import Pool, PoolAccount
from app.domain.enums import AuditAction, PoolStatus
from app.domain.trade import Cashflow


ACCOUNT_TYPES = frozenset({"BANK", "CASH", "THIRD_PARTY"})
ACCOUNT_OWNERSHIPS = frozenset({"OWNED", "CUSTODY", "THIRD_PART"})


def get_pool(session: Session, code: str) -> Pool:
    pool = session.scalar(select(Pool).where(Pool.code == code))
    if pool is None:
        raise NotFound(f"资金池 {code} 不存在", details={"pool_code": code})
    return pool


def create_pool_account(
    session: Session,
    *,
    pool_id: int,
    account_no: str,
    account_name: str,
    account_type: str,
    ownership: str,
    opening_balance: Decimal,
    actor: str,
    note: str | None = None,
) -> PoolAccount:
    pool = session.get(Pool, pool_id)
    if pool is None:
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation("停用资金池不能新增账户", details={"pool_id": pool_id})
    account_no = account_no.strip().upper()
    account_name = account_name.strip()
    if not account_no or not account_name:
        raise Validation("账户编号和名称必填")
    if account_type not in ACCOUNT_TYPES:
        raise Validation("账户类型无效", details={"account_type": account_type})
    if ownership not in ACCOUNT_OWNERSHIPS:
        raise Validation("账户归属无效", details={"ownership": ownership})
    if session.scalar(select(PoolAccount).where(PoolAccount.account_no == account_no)) is not None:
        raise Conflict("账户编号已存在", details={"account_no": account_no})
    balance = to_money(opening_balance)
    if balance < 0:
        raise Validation("期初余额不能为负数")
    account = PoolAccount(
        pool_id=pool_id,
        account_no=account_no,
        account_name=account_name,
        account_type=account_type,
        ownership=ownership,
        opening_balance=balance,
        status="ACTIVE",
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(account)
    session.flush()
    record_audit(
        session,
        action=AuditAction.POOL_CREATE,
        entity_type="pool_account",
        entity_id=account.account_no,
        actor=actor,
        after={"pool_id": pool_id, "account_no": account.account_no, "status": account.status},
    )
    return account


def list_pool_accounts(session: Session, *, pool_id: int | None = None) -> list[PoolAccount]:
    stmt = select(PoolAccount).order_by(PoolAccount.account_no)
    if pool_id is not None:
        stmt = stmt.where(PoolAccount.pool_id == pool_id)
    return list(session.scalars(stmt).all())


def pool_account_balance(session: Session, account: PoolAccount) -> Decimal:
    signed_amount = case(
        (Cashflow.direction == "IN", Cashflow.amount),
        else_=-Cashflow.amount,
    )
    flow_total = session.scalar(
        select(func.coalesce(func.sum(signed_amount), 0)).where(
            Cashflow.pool_account_id == account.id,
            Cashflow.status == "APPROVED",
        )
    ) or 0
    return to_money(account.opening_balance) + to_money(flow_total)


def set_pool_account_status(session: Session, account_id: int, *, status: str, actor: str) -> PoolAccount:
    if status not in {"ACTIVE", "DISABLED"}:
        raise Validation("账户状态无效", details={"status": status})
    account = session.get(PoolAccount, account_id)
    if account is None:
        raise NotFound("资金账户不存在", details={"account_id": account_id})
    account.status = status
    account.updated_by = actor
    record_audit(
        session,
        action=AuditAction.POOL_UPDATE,
        entity_type="pool_account",
        entity_id=account.account_no,
        actor=actor,
        after={"status": status},
    )
    return account


def batch_set_pool_account_status(
    session: Session,
    account_ids: list[int],
    *,
    status: str,
    reason: str,
    actor: str,
) -> list[PoolAccount]:
    if status not in {"ACTIVE", "DISABLED"}:
        raise Validation("账户状态无效", details={"status": status})
    if not account_ids or len(account_ids) > 100 or len(account_ids) != len(set(account_ids)):
        raise Validation("账户 ID 必须为 1-100 个且不能重复")
    reason = reason.strip()
    if not reason:
        raise Validation("批量变更必须填写原因")
    rows = list(session.scalars(select(PoolAccount).where(PoolAccount.id.in_(account_ids))).all())
    by_id = {row.id: row for row in rows}
    missing = [account_id for account_id in account_ids if account_id not in by_id]
    if missing:
        raise NotFound("资金账户不存在", details={"account_ids": missing})
    for account_id in account_ids:
        row = by_id[account_id]
        before = {"status": row.status}
        row.status = status
        row.updated_by = actor
        record_audit(
            session,
            action=AuditAction.POOL_UPDATE,
            entity_type="pool_account",
            entity_id=row.account_no,
            actor=actor,
            before=before,
            after={"status": status, "batch": True},
            reason=reason,
        )
    session.flush()
    return [by_id[account_id] for account_id in account_ids]


__all__ = ["batch_set_pool_account_status", "create_pool_account", "get_pool", "list_pool_accounts", "pool_account_balance", "set_pool_account_status"]
