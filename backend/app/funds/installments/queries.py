"""installments.queries：分期合约列表与合计的只读查询（无写事务）。

`_apply_installment_filters` 是列表与合计**同一份**筛选条件，保证两处口径不漂移；
从 create.py 拆出后，建档写事务与只读查询各自内聚。
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from app.domain.enums import InstallmentStatus
from app.domain.trade import Installment, InstallmentDisposition, InstallmentSchedule, Order
from app.domain.parties import Counterparty, Customer, OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import Account


def _apply_installment_filters(
    stmt,
    *,
    session: Session,
    status: str | None = None,
    order_id: int | None = None,
    contract_type: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
):
    """分期合约的公共筛选条件（列表与合计必须同一份，避免口径漂移）。

    调用方需已 `join(Order)`：日期区间按**订单成交日期**筛，与前端原先的本地筛选同义。
    `contract_type` 是 Installment 自身列（非 Order），面板按类型分列时列表与合计须同条件。
    """
    if status:
        stmt = stmt.where(Installment.status == status)
    if order_id:
        stmt = stmt.where(Installment.order_id == order_id)
    if contract_type:
        stmt = stmt.where(Installment.contract_type == contract_type)
    if trade_date_from is not None:
        stmt = stmt.where(Order.trade_date >= trade_date_from)
    if trade_date_to is not None:
        stmt = stmt.where(Order.trade_date <= trade_date_to)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt


def list_installments(
    session: Session,
    *,
    status: str | None = None,
    order_id: int | None = None,
    contract_type: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
    limit: int | None = None,
    offset: int = 0,
    sort_desc: bool = False,
) -> list[Installment]:
    stmt = _apply_installment_filters(
        select(Installment).join(Order, Order.id == Installment.order_id),
        session=session,
        status=status,
        order_id=order_id,
        contract_type=contract_type,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=user,
    )
    ordering = Installment.id.desc() if sort_desc else Installment.id.asc()
    return list(session.scalars(stmt.order_by(ordering).limit(limit).offset(offset)).all())


def count_installments(
    session: Session, *, status: str | None = None, order_id: int | None = None,
    contract_type: str | None = None, trade_date_from: date | None = None,
    trade_date_to: date | None = None, user: CurrentUser | None = None,
) -> int:
    stmt = _apply_installment_filters(
        select(func.count(Installment.id)).join(Order, Order.id == Installment.order_id),
        session=session, status=status, order_id=order_id, contract_type=contract_type,
        trade_date_from=trade_date_from, trade_date_to=trade_date_to, user=user,
    )
    return int(session.scalar(stmt) or 0)


def installment_order_context(
    session: Session,
    orders: list[Order],
) -> dict[int, dict[str, object]]:
    """批量组装分期列表需要的订单事实，避免前端再拉全量订单。"""
    if not orders:
        return {}

    order_ids = [order.id for order in orders]
    account_ids = [order.account_id for order in orders if order.account_id is not None]
    accounts = {
        account.id: account
        for account in session.execute(
            select(Account.id, Account.game_type, Account.game_account, Account.business_mode, Account.bound_phone)
            .where(Account.id.in_(account_ids))
        ).all()
    } if account_ids else {}

    parties: dict[int, str] = {}
    for order_id, name in session.execute(
        select(OrderCustomerRole.order_id, Customer.display_name)
        .join(Customer, Customer.id == OrderCustomerRole.customer_id)
        .where(OrderCustomerRole.order_id.in_(order_ids))
    ).all():
        parties.setdefault(order_id, name)
    for order_id, name in session.execute(
        select(OrderCounterpartyRole.order_id, Counterparty.display_name)
        .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
        .where(OrderCounterpartyRole.order_id.in_(order_ids))
    ).all():
        parties.setdefault(order_id, name)

    result: dict[int, dict[str, object]] = {}
    for order in orders:
        account = accounts.get(order.account_id)
        snapshot = order.account_snapshot or {}
        delivery = order.form_extra or {}
        result[order.id] = {
            "id": order.id,
            "order_no": order.order_no,
            "order_type": order.order_type,
            "trade_date": order.trade_date,
            "account_game_type": (account.game_type if account else None) or snapshot.get("game_type"),
            "account_game_account": (account.game_account if account else None) or snapshot.get("game_account"),
            "account_business_mode": account.business_mode if account else None,
            "party_name": parties.get(order.id),
            # 已保存的卖号交付资料是当前值；显式清空时也不能回退到旧账号快照。
            "bound_phone": delivery.get(
                "sell_bound_phone", (account.bound_phone if account else None) or snapshot.get("bound_phone")
            ),
            "bound_phone_owner": delivery.get("sell_bound_phone_owner", snapshot.get("bound_phone_owner")),
        }
    return result


def list_installment_export_details(
    session: Session,
    installment_ids: list[int],
) -> tuple[
    dict[int, list[InstallmentSchedule]],
    dict[int, list[InstallmentDisposition]],
]:
    """批量读取导出所需的期次和处置明细，避免按合约逐条查询。"""
    if not installment_ids:
        return {}, {}

    schedules_by_installment: dict[int, list[InstallmentSchedule]] = defaultdict(list)
    schedules = session.scalars(
        select(InstallmentSchedule)
        .where(InstallmentSchedule.installment_id.in_(installment_ids))
        .order_by(InstallmentSchedule.installment_id, InstallmentSchedule.period_no)
    ).all()
    for schedule in schedules:
        schedules_by_installment[schedule.installment_id].append(schedule)

    dispositions_by_installment: dict[int, list[InstallmentDisposition]] = defaultdict(list)
    dispositions = session.scalars(
        select(InstallmentDisposition)
        .where(InstallmentDisposition.installment_id.in_(installment_ids))
        .order_by(
            InstallmentDisposition.installment_id,
            InstallmentDisposition.occurred_on,
            InstallmentDisposition.id,
        )
    ).all()
    for disposition in dispositions:
        dispositions_by_installment[disposition.installment_id].append(disposition)

    return dict(schedules_by_installment), dict(dispositions_by_installment)


def installment_totals(
    session: Session,
    *,
    status: str | None = None,
    order_id: int | None = None,
    contract_type: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Decimal]:
    """按与列表**完全相同**的条件聚合总应收 / 已收 / 剩余（Decimal，服务端唯一口径）。

    已取消合约保留列表历史，但不计入应收、已收和剩余汇总。
    """
    receivable = (
        Installment.down_payment
        + Installment.per_period * Installment.periods
        + func.coalesce(Installment.final_period_adjustment, 0)
        - Installment.waived_amount
    )
    remaining = func.greatest(
        receivable
        - Installment.paid_amount
        - func.coalesce(Installment.bad_debt_amount, 0),
        0,
    )
    effective = Installment.status != InstallmentStatus.CANCELLED.value
    stmt = _apply_installment_filters(
        select(
            func.coalesce(func.sum(case((effective, receivable), else_=0)), 0),
            func.coalesce(func.sum(case((effective, Installment.paid_amount), else_=0)), 0),
            func.coalesce(func.sum(case((effective, remaining), else_=0)), 0),
            func.count(Installment.id),
            func.coalesce(
                func.sum(
                    case(
                        (Installment.status == InstallmentStatus.OVERDUE.value, 1),
                        else_=0,
                    )
                ),
                0,
            ),
        ).join(Order, Order.id == Installment.order_id),
        session=session,
        status=status,
        order_id=order_id,
        contract_type=contract_type,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=user,
    )
    total_receivable, total_paid, total_remaining, total_count, overdue_count = session.execute(stmt).one()
    return {
        "total_receivable": to_money(total_receivable or 0),
        "total_paid": to_money(total_paid or 0),
        "total_remaining": to_money(total_remaining or 0),
        "total_count": int(total_count or 0),
        "overdue_count": int(overdue_count or 0),
    }
