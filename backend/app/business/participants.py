"""建单参与方解析：复用现有档案或在订单事务内新建。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser
from app.domain.parties import Counterparty, Customer
from app.customers.counterparties import create_counterparty
from app.customers.customers import create_customer

from .schemas import CounterpartyDraftInput, CustomerDraftInput


def resolve_customer_role(
    session: Session, draft: CustomerDraftInput | None, user: CurrentUser
) -> tuple[int, str] | None:
    if draft is None:
        return None
    candidates = session.scalars(
        select(Customer)
        .where(Customer.display_name == draft.display_name)
        .order_by(Customer.id)
    ).all()
    # 联系方式是客户复用的明确信号：只要表单输入了手机号或微信，必须精确命中，
    # 不能因另一项为空就把同名的其他人误关联。两项都未填时，沿用建单页面的
    # "同昵称优先复用" 口径。
    customer = next(
        (
            item
            for item in candidates
            if (
                not draft.phone and not draft.wechat
            )
            or (draft.phone and item.phone == draft.phone)
            or (draft.wechat and item.wechat == draft.wechat)
        ),
        None,
    )
    if customer is None:
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
    return customer.id, draft.role


def resolve_counterparty_role(
    session: Session, draft: CounterpartyDraftInput | None, user: CurrentUser
) -> tuple[int, str] | None:
    if draft is None:
        return None
    counterparty = session.scalar(
        select(Counterparty)
        .where(Counterparty.display_name == draft.display_name)
        .where(Counterparty.type == draft.type)
        .order_by(Counterparty.id)
    )
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
    return counterparty.id, draft.role
