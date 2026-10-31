"""parties.customers：客户档案的建档、查询、变更、合并与参与方校验。

规则来源：CUS-01、《ERP_接口错误码与状态机_v1.0.md》。

- 客户 `CUS0001` 编号域独立，创建后不可改、不可复用；
- 联系方式非唯一：重复只产生候选，**不拦截**；
- 停用 / 已合并对象不可作为新订单参与方（`CUSTOMER_DISABLED`）；
- 合并仅管理员：来源置 `MERGED`，迁移参与关系，保留原编号与审计。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.security import CurrentUser, owner_scope_filter, owner_scope_ids
from app.domain.enums import (
    AuditAction,
    CustomerStatus,
    EntityType,
    OrderStatus,
    ScheduleStatus,
    SequenceKey,
)
from app.domain.foundation import AuditLog
from app.domain.parties import Customer, CustomerLead, OrderCustomerRole
from app.domain.trade import Installment, InstallmentSchedule, Order, OrderEvent

from ._common import (
    CONTACT_FIELDS,
    _normalize_extra_values,
    _required_text,
    _validate_owner_id,
)
from .fields import (
    _validate_extra_values,
    _validate_required_extras,
    set_extra_values,
)

# --------------------------------------------------------------------- 客户
def create_customer(
    session: Session,
    *,
    display_name: str,
    actor: str,
    contact_name: str | None = None,
    phone: str | None = None,
    wechat: str | None = None,
    qq: str | None = None,
    source: str | None = None,
    owner_id: int | None = None,
    tags: Sequence[str] | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Customer:
    name = _required_text(
        display_name, message="称呼/昵称必填", field="display_name"
    )
    _validate_owner_id(session, owner_id)

    extras = _normalize_extra_values(extra_values)
    _validate_required_extras(session, EntityType.CUSTOMER.value, extras)
    if extras:
        _validate_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=None,
            values=extras.items(),
        )

    customer = Customer(
        customer_no=allocate_number(session, SequenceKey.CUSTOMER),
        display_name=name,
        contact_name=contact_name,
        phone=phone,
        wechat=wechat,
        qq=qq,
        source=source,
        owner_id=owner_id,
        tags=list(tags or []),
        note=note,
        status=CustomerStatus.ACTIVE.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(customer)
    session.flush()
    if extras:
        set_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )
    record_audit(
        session,
        action=AuditAction.CUSTOMER_CREATE,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        after={"display_name": name, "status": customer.status, **({"extra_values": extras} if extras else {})},
    )
    return customer


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


def list_customers(
    session: Session, *, keyword: str | None = None, status: str | None = None,
    user: CurrentUser | None = None, limit: int | None = None, offset: int = 0,
) -> list[Customer]:
    stmt = _customer_list_stmt(keyword=keyword, status=status, user=user, session=session)
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list(session.scalars(stmt.order_by(Customer.id)).all())


def count_customers(
    session: Session, *, keyword: str | None = None, status: str | None = None,
    user: CurrentUser | None = None,
) -> int:
    stmt = _customer_list_stmt(keyword=keyword, status=status, user=user, session=session)
    return int(session.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


def _customer_list_stmt(
    *, keyword: str | None, status: str | None, user: CurrentUser | None, session: Session
):
    stmt = select(Customer)
    if status:
        stmt = stmt.where(Customer.status == status)
    if keyword:
        pattern = f"%{keyword.strip()}%"
        stmt = stmt.where(
            or_(
                Customer.display_name.like(pattern),
                Customer.customer_no.like(pattern),
                Customer.phone.like(pattern),
                Customer.wechat.like(pattern),
                Customer.qq.like(pattern),
            )
        )
    if user is not None:
        scope = owner_scope_filter(Customer.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt


def get_customer_activity_summary(
    session: Session,
    customer_ids: Sequence[int],
    user: CurrentUser | None = None,
) -> dict[int, dict[str, Any]]:
    """从订单参与关系与事件时间线汇总客户列表的经营摘要。"""
    ids = {customer_id for customer_id in customer_ids if isinstance(customer_id, int)}
    summary = {
        customer_id: {
            "order_roles": [],
            "active_order_count": 0,
            "last_interaction_at": None,
        }
        for customer_id in ids
    }
    if not ids:
        return summary
    order_ids_by_customer: dict[int, set[int]] = {customer_id: set() for customer_id in ids}
    active_order_ids_by_customer: dict[int, set[int]] = {
        customer_id: set() for customer_id in ids
    }
    stmt = select(OrderCustomerRole, Order).join(
        Order, Order.id == OrderCustomerRole.order_id
    ).where(OrderCustomerRole.customer_id.in_(ids))
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None:
        stmt = stmt.where(scope)
    rows = session.execute(stmt).all()
    for role_row, order in rows:
        item = summary[role_row.customer_id]
        if role_row.role not in item["order_roles"]:
            item["order_roles"].append(role_row.role)
        order_ids_by_customer[role_row.customer_id].add(order.id)
        if order.status == "ACTIVE":
            active_order_ids_by_customer[role_row.customer_id].add(order.id)
        if order.created_at and (
            item["last_interaction_at"] is None
            or order.created_at > item["last_interaction_at"]
        ):
            item["last_interaction_at"] = order.created_at

    event_stmt = select(OrderCustomerRole.customer_id, OrderEvent.created_at).join(
        OrderEvent, OrderEvent.order_id == OrderCustomerRole.order_id
    ).join(Order, Order.id == OrderCustomerRole.order_id).where(
        OrderCustomerRole.customer_id.in_(ids)
    )
    if scope is not None:
        event_stmt = event_stmt.where(scope)
    event_rows = session.execute(
        event_stmt
    ).all()
    for customer_id, created_at in event_rows:
        if created_at and (
            summary[customer_id]["last_interaction_at"] is None
            or created_at > summary[customer_id]["last_interaction_at"]
        ):
            summary[customer_id]["last_interaction_at"] = created_at
    for item in summary.values():
        item["order_roles"].sort()
    for customer_id, order_ids in active_order_ids_by_customer.items():
        summary[customer_id]["active_order_count"] = len(order_ids)
    return summary


def get_customer(session: Session, customer_id: int, user: CurrentUser | None = None) -> Customer:
    customer = session.get(Customer, customer_id)
    if customer is None:
        raise NotFound(f"客户 {customer_id} 不存在", details={"customer_id": customer_id})
    if user is not None and user.owner_scope != "ALL" and not user.is_admin:
        visible_ids = owner_scope_ids(session, user)
        if customer.owner_id not in (visible_ids or set()):
            raise NotFound(f"客户 {customer_id} 不存在", details={"customer_id": customer_id})
    return customer


def get_customer_detail(
    session: Session, customer_id: int, user: CurrentUser | None = None
) -> dict[str, Any]:
    """返回客户详情页四个页签所需的聚合数据（CUS-01-03）。

    订单、分期金额和逾期数均从业务事实表实时汇总；这里不保存任何手工汇总值。
    """
    customer = get_customer(session, customer_id, user)
    role_stmt = select(OrderCustomerRole, Order).join(
        Order, Order.id == OrderCustomerRole.order_id
    ).where(OrderCustomerRole.customer_id == customer.id)
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None:
        role_stmt = role_stmt.where(scope)
    role_rows = session.execute(
        role_stmt.order_by(Order.trade_date.desc(), Order.id.desc())
    ).all()

    business_by_order: dict[int, dict[str, Any]] = {}
    for role_row, order in role_rows:
        item = business_by_order.setdefault(
            order.id,
            {
                "order_id": order.id,
                "order_no": order.order_no,
                "order_type": order.order_type,
                "capital_type": order.capital_type,
                "status": order.status,
                "trade_date": order.trade_date,
                "owner_id": order.owner_id,
                "roles": [],
            },
        )
        if role_row.role not in item["roles"]:
            item["roles"].append(role_row.role)

    orders = list(business_by_order.values())
    order_ids = list(business_by_order)
    installments = list(
        session.scalars(
            select(Installment)
            .where(Installment.order_id.in_(order_ids))
            .order_by(Installment.id.desc())
        ).all()
    ) if order_ids else []
    installment_ids = [item.id for item in installments]
    schedules = list(
        session.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id.in_(installment_ids)
            )
        ).all()
    ) if installment_ids else []
    overdue_by_installment: dict[int, int] = {}
    for schedule in schedules:
        if schedule.status == ScheduleStatus.OVERDUE.value:
            overdue_by_installment[schedule.installment_id] = (
                overdue_by_installment.get(schedule.installment_id, 0) + 1
            )

    order_no_by_id = {item["order_id"]: item["order_no"] for item in orders}
    installment_items: list[dict[str, Any]] = []
    paid_total = Decimal("0.00")
    receivable_total = Decimal("0.00")
    overdue_period_count = 0
    for item in installments:
        receivable = (
            to_money(item.down_payment)
            + to_money(item.per_period) * int(item.periods)
            + to_money(item.final_period_adjustment or 0)
            - to_money(item.waived_amount)
        )
        paid = to_money(item.paid_amount)
        remaining = receivable - paid
        overdue_periods = overdue_by_installment.get(item.id, 0)
        paid_total += paid
        receivable_total += receivable
        overdue_period_count += overdue_periods
        installment_items.append(
            {
                "id": item.id,
                "inst_no": item.inst_no,
                "order_id": item.order_id,
                "order_no": order_no_by_id.get(item.order_id),
                "contract_type": item.contract_type,
                "status": item.status,
                "principal": to_money(item.principal),
                "total_receivable": receivable,
                "paid_amount": paid,
                "remaining_amount": remaining,
                "overdue_periods": overdue_periods,
                "first_due_on": item.first_due_on,
            }
        )

    audit_rows = session.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "customer",
            AuditLog.entity_id == customer.customer_no,
        )
        .order_by(AuditLog.id.desc())
        .limit(100)
    ).all()
    audit_items = [
        {
            "id": row.id,
            "action": row.action,
            "entity_type": row.entity_type,
            "entity_id": row.entity_id,
            "actor": row.actor,
            "before": row.before_json,
            "after": row.after_json,
            "reason": row.reason,
            "request_id": row.request_id,
            "occurred_at": row.occurred_at,
        }
        for row in audit_rows
    ]
    last_trade_date = max(
        (item["trade_date"] for item in orders), default=None
    )
    return {
        "overview": {
            "order_count": len(orders),
            "active_order_count": sum(
                item["status"] == OrderStatus.ACTIVE.value for item in orders
            ),
            "completed_order_count": sum(
                item["status"] == OrderStatus.COMPLETED.value for item in orders
            ),
            "cancelled_order_count": sum(
                item["status"] == OrderStatus.CANCELLED.value for item in orders
            ),
            "last_trade_date": last_trade_date,
            "installment_paid_total": paid_total,
            "installment_receivable_total": receivable_total,
            "installment_remaining_total": receivable_total - paid_total,
            "overdue_period_count": overdue_period_count,
        },
        "business": orders,
        "installments": installment_items,
        "audit": audit_items,
    }


def update_customer(
    session: Session,
    customer_id: int,
    *,
    actor: str,
    extra_values: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
    **fields: Any,
) -> Customer:
    customer = get_customer(session, customer_id, user)
    if customer.status == CustomerStatus.MERGED.value:
        raise Conflict(
            "已合并客户不可修改",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"customer_no": customer.customer_no},
        )

    extras = _normalize_extra_values(extra_values)
    if extras:
        _validate_required_extras(
            session, EntityType.CUSTOMER.value, extras, partial=True
        )
        _validate_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    allowed_fields = {
        "display_name", "contact_name", "phone", "wechat", "qq", "source",
        "owner_id", "tags", "note",
    }
    for name in fields:
        if name not in allowed_fields:
            raise Validation("客户更新字段不受支持", details={"field": name})
    if "owner_id" in fields and user is not None and not user.is_admin and user.owner_scope != "ALL":
        fields["owner_id"] = user.id
    if "owner_id" in fields:
        _validate_owner_id(session, fields["owner_id"])

    normalized_fields: dict[str, Any] = {}
    for name, value in fields.items():
        if name == "display_name":
            if not isinstance(value, str) or not value.strip():
                raise Validation("称呼/昵称不能清空", details={"field": name})
            value = value.strip()
        normalized_fields[name] = value

    before = {name: getattr(customer, name) for name in CONTACT_FIELDS}
    changed_contacts = False
    for name, value in normalized_fields.items():
        if getattr(customer, name, None) != value:
            setattr(customer, name, value)
            if name in CONTACT_FIELDS:
                changed_contacts = True
    customer.updated_by = actor
    session.flush()

    saved_extras: dict[str, Any] = {}
    if extras:
        saved_extras = set_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    action = AuditAction.CONTACT_WRITE if changed_contacts else AuditAction.CUSTOMER_UPDATE
    record_audit(
        session,
        action=action,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        before=before,
        after={
            **{name: getattr(customer, name) for name in CONTACT_FIELDS},
            **({"extra_values": saved_extras} if saved_extras else {}),
        },
    )
    return customer


def set_customer_status(
    session: Session,
    customer_id: int,
    status: str,
    *,
    actor: str,
    extra_values: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Customer:
    customer = get_customer(session, customer_id, user)
    if status not in CustomerStatus.values():
        raise Validation(
            f"客户状态无效，必须为 {CustomerStatus.values()}",
            details={"field": "status", "value": status},
        )
    if status == CustomerStatus.MERGED.value:
        raise Validation(
            "MERGED 只能由合并动作产生", details={"field": "status", "value": status}
        )
    if customer.status == CustomerStatus.MERGED.value:
        raise Validation(
            "已合并客户不可修改状态",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"customer_no": customer.customer_no, "status": customer.status},
        )
    extras = _normalize_extra_values(extra_values)
    if extras:
        _validate_required_extras(
            session, EntityType.CUSTOMER.value, extras, partial=True
        )
        _validate_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    before = customer.status
    customer.status = status
    customer.updated_by = actor
    session.flush()

    saved_extras: dict[str, Any] = {}
    if extras:
        saved_extras = set_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        before={"status": before},
        after={
            "status": status,
            **({"extra_values": saved_extras} if saved_extras else {}),
        },
    )
    return customer


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

    # 迁移参与关系：目标已有同订单同角色则跳过（UNIQUE(order, customer, role)）
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
