"""建单参与方解析：复用现有档案或在订单事务内新建。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser, PERM_CUSTOMER_CREATE, PERM_CUSTOMER_UPDATE, PERM_COUNTERPARTY_MANAGE
from app.core.errors import PermissionDenied, Validation
from app.domain.parties import Counterparty, Customer
from app.customers.counterparties import create_counterparty, update_counterparty
from app.customers.customers import create_customer, update_customer

from .schemas import CounterpartyDraftInput, CustomerDraftInput


def resolve_customer_role(
    session: Session, draft: CustomerDraftInput | None, user: CurrentUser, *, require_create_permission: bool = False,
    update_existing: bool = False,
) -> tuple[int, str] | None:
    if draft is None:
        return None
    candidates = session.scalars(
        select(Customer)
        .where(Customer.display_name == draft.display_name)
        .order_by(Customer.id)
    ).all()
    # 售出沿用联系方式匹配；建单允许更新唯一同名客户，多个候选必须能唯一匹配。
    matches = [
        item for item in candidates
        if (not draft.phone and not draft.wechat)
        or (draft.phone and item.phone == draft.phone)
        or (draft.wechat and item.wechat == draft.wechat)
    ]
    if update_existing:
        if len(matches) == 1:
            customer = matches[0]
        elif len(candidates) == 1:
            customer = candidates[0]
        elif candidates:
            raise Validation("存在多个同名客户，无法确定要更新的档案，请先处理客户档案")
        else:
            customer = None
    else:
        customer = matches[0] if matches else None
    if customer is None:
        if require_create_permission and not user.has(PERM_CUSTOMER_CREATE):
            raise PermissionDenied("当前角色无权新建客户")
        customer = create_customer(
            session,
            display_name=draft.display_name,
            contact_name=draft.contact_name,
            phone=draft.phone,
            wechat=draft.wechat,
            qq=draft.qq,
            source=draft.source,
            note=draft.note,
            actor=user.username,
        )
    elif update_existing:
        fields = {
            key: value for key in ("contact_name", "phone", "wechat", "qq")
            if (value := getattr(draft, key)) and value != getattr(customer, key)
        }
        if fields:
            if not user.has(PERM_CUSTOMER_UPDATE):
                raise PermissionDenied("当前角色无权更新客户资料")
            update_customer(session, customer.id, actor=user.username, user=user, **fields)
    return customer.id, draft.role


def resolve_counterparty_role(
    session: Session, draft: CounterpartyDraftInput | None, user: CurrentUser
) -> tuple[int, str] | None:
    if draft is None:
        return None
    candidates = session.scalars(
        select(Counterparty)
        .where(Counterparty.display_name == draft.display_name)
        .where(Counterparty.type == draft.type)
        .order_by(Counterparty.id)
    ).all()
    matches = [
        item for item in candidates
        if (draft.phone and item.phone == draft.phone) or (draft.wechat and item.wechat == draft.wechat)
    ]
    if len(matches) == 1:
        counterparty = matches[0]
    elif len(candidates) == 1:
        counterparty = candidates[0]
    elif candidates:
        raise Validation("存在多个同名供货方，无法确定要更新的档案，请先处理供货方档案")
    else:
        counterparty = None
    if counterparty is None:
        counterparty = create_counterparty(
            session,
            display_name=draft.display_name,
            type=draft.type,
            contact_name=draft.contact_name,
            phone=draft.phone,
            wechat=draft.wechat,
            qq=draft.qq,
            note=draft.note,
            actor=user.username,
        )
    else:
        fields = {
            key: value for key in ("contact_name", "phone", "wechat", "qq")
            if (value := getattr(draft, key)) and value != getattr(counterparty, key)
        }
        if fields:
            if not user.has(PERM_COUNTERPARTY_MANAGE):
                raise PermissionDenied("当前角色无权更新供货方资料")
            update_counterparty(session, counterparty.id, actor=user.username, **fields)
    return counterparty.id, draft.role
