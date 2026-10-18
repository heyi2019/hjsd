"""parties.service：客户、合作方、参与方校验、活字段的 Service 层。

规则来源：CUS-01、BAS-02-05、BAS-04、《ERP_接口错误码与状态机_v1.0.md》。

- 客户 `CUS0001` / 合作方 `CP0001` 编号域独立，创建后不可改、不可复用；
- 联系方式非唯一：重复只产生候选，**不拦截**；
- 停用 / 已合并对象不可作为新订单参与方（`CUSTOMER_DISABLED` / `COUNTERPARTY_DISABLED`）；
- 合并仅管理员：来源置 `MERGED`，迁移参与关系，保留原编号与审计。
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal
from typing import Any

from sqlalchemy import func, inspect, or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter, owner_scope_ids
from app.core.numbering import allocate_number
from app.domain.enums import (
    AuditAction,
    CounterpartyStatus,
    CounterpartyType,
    CustomerStatus,
    EntityType,
    FieldType,
    LeadStatus,
    LeadType,
    OrderStatus,
    ScheduleStatus,
    SequenceKey,
)
from app.domain.parties import (
    Counterparty,
    Customer,
    CustomerLead,
    EntityExtraValue,
    FieldDefinition,
    OrderCustomerRole,
)
from app.domain.foundation import AuditLog, Pool
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentSchedule,
    Order,
    OrderEvent,
)
from app.domain.users import User

from ._common import (
    CONTACT_FIELDS,
    FIELD_KEY_PATTERN,
    ORDER_TYPE_CODE_PATTERN,
    _ENTITY_LABELS,
    _EXTRA_ENTITY_MODELS,
    _FIXED_OUTPUT_FIELDS,
    _UNSET,
    _fixed_entity_fields,
    mask_id,
    mask_phone,
    _normalize_extra_values,
    _required_bool,
    _required_text,
    _validate_owner_id,
    to_customer_out,
)
from .fields import (
    _validate_extra_values,
    _validate_required_extras,
    create_field_definition,
    delete_field_definition,
    get_extra_values,
    get_extra_values_bulk,
    list_field_definitions,
    set_extra_values,
    set_field_definition_active,
    update_field_definition,
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

    stmt = select(Customer).where(or_(*conditions))
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
    user: CurrentUser | None = None,
) -> list[Customer]:
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
    return list(session.scalars(stmt.order_by(Customer.id)).all())


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
    before = customer.status
    customer.status = status
    customer.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        before={"status": before},
        after={"status": status},
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

    # 活字段是客户资料的一部分：目标已有同一字段时保留目标值，
    # 目标缺失时复制一份；来源行不删除，保证合并前的历史值仍可审计。
    source_extras = session.scalars(
        select(EntityExtraValue).where(
            EntityExtraValue.entity_type == EntityType.CUSTOMER.value,
            EntityExtraValue.entity_id == source.id,
        )
    ).all()
    target_extra_definition_ids = set(
        session.scalars(
            select(EntityExtraValue.field_definition_id).where(
                EntityExtraValue.entity_type == EntityType.CUSTOMER.value,
                EntityExtraValue.entity_id == target.id,
            )
        ).all()
    )
    migrated_extras = 0
    for extra in source_extras:
        if extra.field_definition_id in target_extra_definition_ids:
            continue
        session.add(
            EntityExtraValue(
                entity_type=extra.entity_type,
                entity_id=target.id,
                field_definition_id=extra.field_definition_id,
                value=dict(extra.value or {}),
            )
        )
        target_extra_definition_ids.add(extra.field_definition_id)
        migrated_extras += 1

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


def _get_lead_for_user(
    session: Session, lead_id: int, user: CurrentUser | None = None
) -> CustomerLead:
    lead = session.get(CustomerLead, lead_id)
    if lead is None:
        raise NotFound("客户需求不存在", details={"lead_id": lead_id})
    if user is not None:
        scope = owner_scope_filter(CustomerLead.owner_id, user, session)
        if scope is not None and not session.scalar(
            select(CustomerLead.id).where(CustomerLead.id == lead_id, scope)
        ):
            raise NotFound("客户需求不存在", details={"lead_id": lead_id})
    return lead


def get_lead(
    session: Session, lead_id: int, user: CurrentUser | None = None
) -> CustomerLead:
    return _get_lead_for_user(session, lead_id, user)


def create_lead(
    session: Session,
    *,
    customer_id: int,
    request_type: str,
    target: str,
    actor: str,
    budget: Decimal | None = None,
    owner_id: int | None = None,
    note: str | None = None,
    user: CurrentUser | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> CustomerLead:
    customer = assert_customer_usable(session, customer_id, user=user)
    try:
        LeadType(request_type)
    except ValueError as exc:
        raise Validation(
            f"需求类型必须为 {LeadType.values()}",
            details={"field": "request_type", "value": request_type},
        ) from exc
    target_text = _required_text(target, message="需求目标必填", field="target")
    if budget is not None and to_money(budget) < 0:
        raise Validation("需求预算不能为负数", details={"field": "budget"})
    _validate_owner_id(session, owner_id)
    lead = CustomerLead(
        lead_no=allocate_number(session, SequenceKey.LEAD),
        customer_id=customer.id,
        request_type=request_type,
        budget=to_money(budget) if budget is not None else None,
        target=target_text,
        owner_id=owner_id,
        note=note,
        status=LeadStatus.OPEN.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(lead)
    session.flush()
    set_extra_values(
        session,
        entity_type=EntityType.LEAD.value,
        entity_id=lead.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.LEAD_CREATE,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        after={"customer_id": customer.id, "request_type": request_type},
    )
    return lead


def list_leads(
    session: Session,
    *,
    customer_id: int | None = None,
    status: str | None = None,
    keyword: str | None = None,
    user: CurrentUser | None = None,
) -> list[CustomerLead]:
    stmt = select(CustomerLead)
    if customer_id is not None:
        stmt = stmt.where(CustomerLead.customer_id == customer_id)
    if status is not None:
        try:
            LeadStatus(status)
        except ValueError as exc:
            raise Validation(
                f"需求状态必须为 {LeadStatus.values()}",
                details={"field": "status", "value": status},
            ) from exc
        stmt = stmt.where(CustomerLead.status == status)
    if keyword:
        text = keyword.strip()
        stmt = stmt.where(
            or_(
                CustomerLead.lead_no.ilike(f"%{text}%"),
                CustomerLead.target.ilike(f"%{text}%"),
            )
        )
    if user is not None:
        scope = owner_scope_filter(CustomerLead.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return list(session.scalars(stmt.order_by(CustomerLead.id.desc())).all())


def update_lead(
    session: Session,
    lead_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    **fields: Any,
) -> CustomerLead:
    lead = _get_lead_for_user(session, lead_id, user)
    if lead.status != LeadStatus.OPEN.value:
        raise Conflict("已转单或关闭的需求不可编辑", details={"lead_no": lead.lead_no})
    allowed = {"budget", "target", "owner_id", "note"}
    unknown = set(fields) - allowed
    if unknown:
        raise Validation("需求更新字段不受支持", details={"fields": sorted(unknown)})
    before = {
        name: (
            str(getattr(lead, name))
            if isinstance(getattr(lead, name), Decimal)
            else getattr(lead, name)
        )
        for name in fields
    }
    if "target" in fields:
        fields["target"] = _required_text(
            fields["target"], message="需求目标必填", field="target"
        )
    if "budget" in fields and fields["budget"] is not None:
        fields["budget"] = to_money(fields["budget"])
        if fields["budget"] < 0:
            raise Validation("需求预算不能为负数", details={"field": "budget"})
    if "owner_id" in fields:
        _validate_owner_id(session, fields["owner_id"])
    for name, value in fields.items():
        setattr(lead, name, value)
    lead.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        values = _normalize_extra_values(extra_values)
        _validate_required_extras(
            session, EntityType.LEAD.value, values, partial=True
        )
        set_extra_values(
            session,
            entity_type=EntityType.LEAD.value,
            entity_id=lead.id,
            values=values.items(),
        )
    record_audit(
        session,
        action=AuditAction.LEAD_UPDATE,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        before=before,
        after={
            name: (
                str(getattr(lead, name))
                if isinstance(getattr(lead, name), Decimal)
                else getattr(lead, name)
            )
            for name in fields
        },
    )
    return lead


def convert_lead(
    session: Session,
    lead_id: int,
    *,
    order_id: int,
    actor: str,
    user: CurrentUser | None = None,
) -> CustomerLead:
    lead = _get_lead_for_user(session, lead_id, user)
    if lead.status != LeadStatus.OPEN.value:
        raise Conflict("只有 OPEN 需求可以转单", details={"lead_no": lead.lead_no})
    order = session.get(Order, order_id)
    if order is None:
        raise NotFound("订单不存在", details={"order_id": order_id})
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None and not session.scalar(
        select(Order.id).where(Order.id == order_id, scope)
    ):
        raise NotFound("订单不存在", details={"order_id": order_id})
    lead.status = LeadStatus.CONVERTED.value
    lead.converted_order_id = order.id
    lead.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.LEAD_CONVERT,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        after={"status": lead.status, "converted_order_no": order.order_no},
    )
    return lead


def close_lead(
    session: Session,
    lead_id: int,
    *,
    reason: str,
    actor: str,
    user: CurrentUser | None = None,
) -> CustomerLead:
    lead = _get_lead_for_user(session, lead_id, user)
    if lead.status != LeadStatus.OPEN.value:
        raise Conflict("只有 OPEN 需求可以关闭", details={"lead_no": lead.lead_no})
    normalized = _required_text(reason, message="关闭需求必须填写原因", field="reason")
    lead.status = LeadStatus.CLOSED.value
    lead.closed_reason = normalized
    lead.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.LEAD_CLOSE,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        after={"status": lead.status},
        reason=normalized,
    )
    return lead


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


# --------------------------------------------------------------------- 合作方
def create_counterparty(
    session: Session,
    *,
    display_name: str,
    type: str,
    actor: str,
    contact_name: str | None = None,
    phone: str | None = None,
    wechat: str | None = None,
    qq: str | None = None,
    source: str | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Counterparty:
    name = _required_text(
        display_name, message="合作方名称必填", field="display_name"
    )
    try:
        CounterpartyType(type)
    except ValueError as exc:
        raise Validation(
            f"合作方类型必须为 {CounterpartyType.values()}",
            details={"field": "type", "value": type},
        ) from exc

    counterparty = Counterparty(
        counterparty_no=allocate_number(session, SequenceKey.COUNTERPARTY),
        display_name=name,
        type=type,
        contact_name=contact_name,
        phone=phone,
        wechat=wechat,
        qq=qq,
        source=source,
        note=note,
        status=CounterpartyStatus.ACTIVE.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(counterparty)
    session.flush()
    set_extra_values(
        session,
        entity_type=EntityType.COUNTERPARTY.value,
        entity_id=counterparty.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.CUSTOMER_CREATE,
        entity_type="counterparty",
        entity_id=counterparty.counterparty_no,
        actor=actor,
        after={"display_name": name, "type": type},
    )
    return counterparty


def list_counterparties(
    session: Session, *, type: str | None = None, status: str | None = None
) -> list[Counterparty]:
    stmt = select(Counterparty)
    if type:
        stmt = stmt.where(Counterparty.type == type)
    if status:
        stmt = stmt.where(Counterparty.status == status)
    return list(session.scalars(stmt.order_by(Counterparty.id)).all())


def get_counterparty(session: Session, counterparty_id: int) -> Counterparty:
    item = session.get(Counterparty, counterparty_id)
    if item is None:
        raise NotFound(
            f"合作方 {counterparty_id} 不存在", details={"counterparty_id": counterparty_id}
        )
    return item


def update_counterparty(
    session: Session,
    counterparty_id: int,
    *,
    actor: str,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    **fields: Any,
) -> Counterparty:
    item = get_counterparty(session, counterparty_id)
    allowed_fields = {
        "display_name", "contact_name", "phone", "wechat", "qq", "source", "note",
    }
    for name in fields:
        if name not in allowed_fields:
            raise Validation("合作方更新字段不受支持", details={"field": name})

    normalized_fields: dict[str, Any] = {}
    for name, value in fields.items():
        if name == "display_name":
            if not isinstance(value, str) or not value.strip():
                raise Validation("合作方名称不能清空", details={"field": name})
            value = value.strip()
        normalized_fields[name] = value
    for name, value in normalized_fields.items():
        setattr(item, name, value)
    item.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        values = _normalize_extra_values(extra_values)
        _validate_required_extras(
            session, EntityType.COUNTERPARTY.value, values, partial=True
        )
        set_extra_values(
            session,
            entity_type=EntityType.COUNTERPARTY.value,
            entity_id=item.id,
            values=values.items(),
        )
    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="counterparty",
        entity_id=item.counterparty_no,
        actor=actor,
        after={"display_name": item.display_name, "status": item.status},
    )
    return item


def set_counterparty_status(
    session: Session, counterparty_id: int, active: bool, *, actor: str
) -> Counterparty:
    """停用后不可参与新订单；有历史参与关系不物理删除（BAS-02-05）。"""
    active = _required_bool(active, field="active")
    item = get_counterparty(session, counterparty_id)
    before = item.status
    item.status = (
        CounterpartyStatus.ACTIVE.value if active else CounterpartyStatus.DISABLED.value
    )
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="counterparty",
        entity_id=item.counterparty_no,
        actor=actor,
        before={"status": before},
        after={"status": item.status},
    )
    return item


def assert_counterparty_usable(
    session: Session, counterparty_id: int, *, expected_type: str | None = None
) -> Counterparty:
    item = get_counterparty(session, counterparty_id)
    if item.status != CounterpartyStatus.ACTIVE.value:
        raise Validation(
            f"合作方 {item.counterparty_no} 已停用，不可作为新订单参与方",
            code=ErrorCode.COUNTERPARTY_DISABLED,
            details={"counterparty_no": item.counterparty_no, "status": item.status},
        )
    if expected_type and item.type != expected_type:
        raise Validation(
            f"合作方类型应为 {expected_type}，实际为 {item.type}",
            code=ErrorCode.PARTICIPANT_ROLE_INVALID,
            details={"counterparty_no": item.counterparty_no, "type": item.type},
        )
    return item


__all__ = [
    "assert_counterparty_usable",
    "assert_customer_usable",
    "close_lead",
    "create_counterparty",
    "create_customer",
    "create_field_definition",
    "create_lead",
    "convert_lead",
    "delete_field_definition",
    "duplicate_candidates",
    "get_counterparty",
    "get_customer",
    "get_customer_detail",
    "get_customer_activity_summary",
    "get_lead",
    "get_extra_values",
    "get_extra_values_bulk",
    "list_counterparties",
    "list_leads",
    "list_customers",
    "list_field_definitions",
    "mask_id",
    "mask_phone",
    "merge_customers",
    "set_counterparty_status",
    "set_customer_status",
    "set_extra_values",
    "set_field_definition_active",
    "to_customer_out",
    "update_lead",
    "update_counterparty",
    "update_customer",
]
