"""parties.customer_merge：重复候选、客户合并与参与方可用性校验。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import ErrorCode, Validation
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import AuditAction, CustomerStatus
from app.domain.parties import Customer, CustomerLead, OrderCustomerRole

from ._common import _required_text

from .customers import get_customer

def duplicate_candidates(
    session: Session,
    *,
    phone: str | None = None,
    wechat: str | None = None,
    qq: str | None = None,
    exclude_customer_id: int | None = None,
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    contacts: list[tuple[str, str, Any]] = []
    for label, value, column in (
        ("phone", phone, Customer.phone),
        ("wechat", wechat, Customer.wechat),
        ("qq", qq, Customer.qq),
    ):
        if value is None:
            continue
        if not isinstance(value, str):
            raise Validation(
                "联系方式必须为文本", details={"field": label}
            )
        normalized = value.strip()
        if normalized:
            contacts.append((label, normalized, column))
    conditions = [column == value for _label, value, column in contacts]
    if not conditions:
        return []

    # 已合并客户不作为重复候选：其资料已并入目标客户，列为候选只会制造噪音
    # （合并目标侧另有「必须 ACTIVE」拦截，但候选列表应从源头排除）。
    stmt = select(Customer).where(
        or_(*conditions), Customer.status != CustomerStatus.MERGED.value
    )
    if user is not None:
        scope = owner_scope_filter(Customer.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    rows = session.scalars(stmt).all()
    candidates: list[dict[str, Any]] = []
    for customer in rows:
        if exclude_customer_id is not None and customer.id == exclude_customer_id:
            continue
        matched = [
            label
            for label, value, _column in contacts
            if getattr(customer, label) == value
        ]
        if matched:
            candidates.append(
                {
                    "customer_id": customer.id,
                    "customer_no": customer.customer_no,
                    "display_name": customer.display_name,
                    "matched_on": matched,
                }
            )
    return candidates


def merge_customers(
    session: Session,
    *,
    source_customer_id: int,
    target_customer_id: int,
    reason: str,
    actor: str,
    user: CurrentUser | None = None,
) -> Customer:
    normalized_reason = _required_text(
        reason,
        field="reason",
        message="客户合并必须填写原因",
    )
    source = get_customer(session, source_customer_id, user)
    target = get_customer(session, target_customer_id, user)
    if source.id == target.id:
        raise Validation("来源与目标不能是同一客户", code=ErrorCode.MERGE_TARGET_INVALID)
    if target.status != CustomerStatus.ACTIVE.value:
        raise Validation(
            "目标客户必须为 ACTIVE",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"target_customer_no": target.customer_no, "status": target.status},
        )
    if source.status == CustomerStatus.MERGED.value:
        raise Validation(
            "来源客户已合并",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"source_customer_no": source.customer_no},
        )

    # 转移参与关系：目标已有同订单同角色则跳过（UNIQUE(order, customer, role)）
    roles = session.scalars(
        select(OrderCustomerRole).where(OrderCustomerRole.customer_id == source.id)
    ).all()
    migrated = 0
    for role in roles:
        exists = session.scalar(
            select(OrderCustomerRole).where(
                OrderCustomerRole.order_id == role.order_id,
                OrderCustomerRole.customer_id == target.id,
                OrderCustomerRole.role == role.role,
            )
        )
        if exists is not None:
            session.delete(role)
            continue
        role.customer_id = target.id
        migrated += 1

    leads = session.scalars(
        select(CustomerLead).where(CustomerLead.customer_id == source.id)
    ).all()
    for lead in leads:
        lead.customer_id = target.id
        lead.updated_by = actor

    # 扩展字段是客户资料的一部分：目标已有的键保留目标值，目标缺失的键复制一份；
    # 来源行不删除（仅置 MERGED），保证合并前的历史值仍可审计。
    source_extras = dict(source.form_extra or {})
    merged_extras = dict(target.form_extra or {})
    migrated_extras = 0
    for field_key, value in source_extras.items():
        if field_key in merged_extras:
            continue
        merged_extras[field_key] = value
        migrated_extras += 1
    if migrated_extras:
        target.form_extra = merged_extras

    before = {"status": source.status, "merged_into_id": source.merged_into_id}
    source.status = CustomerStatus.MERGED.value
    source.merged_into_id = target.id
    source.merged_reason = normalized_reason
    source.updated_by = actor
    session.flush()

    record_audit(
        session,
        action=AuditAction.CUSTOMER_MERGE,
        entity_type="customer",
        entity_id=source.customer_no,
        actor=actor,
        before=before,
        after={
            "status": source.status,
            "merged_into": target.customer_no,
            "migrated_roles": migrated,
            "migrated_extra_values": migrated_extras,
            "migrated_leads": len(leads),
        },
        reason=normalized_reason,
    )
    return target


def assert_customer_usable(
    session: Session, customer_id: int, *, user: CurrentUser | None = None
) -> Customer:
    """新订单参与方校验：停用/已合并一律拒绝（CUS-01-04、A11）。"""
    customer = get_customer(session, customer_id, user)
    if customer.status != CustomerStatus.ACTIVE.value:
        raise Validation(
            f"客户 {customer.customer_no} 状态为 {customer.status}，不可作为新订单参与方",
            code=ErrorCode.CUSTOMER_DISABLED,
            details={"customer_no": customer.customer_no, "status": customer.status},
        )
    return customer
