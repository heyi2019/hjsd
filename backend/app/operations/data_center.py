"""数据中心汇总：售出账号、在库账号和工作室收支的统一口径。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import AccountStatus
from app.domain.trade import Account, Order
from app.finance.cashflow.reads.studio import studio_totals_by_date
from app.finance.deposits.reads import deposit_held_total
from app.business.orders.queries import order_status_counts
from app.business.inventory.inventory import inventory_cost_by_entry_date

from ._shared import ZERO, _apply_order_scope, _validate_date_range, cashflow_totals_by_order


def data_center_summary(
    session: Session,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Decimal | int]:
    """返回数据中心订单规模、成本、利润来源及利润合计。

    订单规模按订单交易日期统计；售出成本和账号售出利润只统计已经出库的账号；
    在途成本统计当前在库账号；押金占用统计可见资金账户的在押金额；
    工作室收支沿用资金中心的已入账手工收支口径。利润合计为账号售出利润
    加工作室其他收入，再减工作室成本。
    """
    _validate_date_range(from_date, to_date)
    status_counts = order_status_counts(
        session,
        trade_date_from=from_date,
        trade_date_to=to_date,
        user=user,
    )
    order_count = sum(status_counts.values())
    active_order_count = sum(
        status_counts.get(status, 0)
        for status in ("ACTIVE", "INSTALLMENT")
    )
    sold_orders_stmt = _apply_order_scope(
        select(Order.id)
        .join(Account, Account.id == Order.account_id)
        .where(Account.status == AccountStatus.SOLD.value),
        user,
        session,
    )
    sold_order_ids = list(session.scalars(sold_orders_stmt).all())
    cashflow_totals = cashflow_totals_by_order(
        session,
        order_ids=sold_order_ids,
        from_date=from_date,
        to_date=to_date,
    )
    sold_cost = sum(
        (totals[2] for totals in cashflow_totals.values()),
        ZERO,
    )
    account_sale_profit = sum(
        (income - expense for income, expense, _buy in cashflow_totals.values()),
        ZERO,
    )

    in_transit_cost = inventory_cost_by_entry_date(
        session,
        date_from=from_date,
        date_to=to_date,
        user=user,
    )
    studio = studio_totals_by_date(
        session,
        occurred_from=from_date,
        occurred_to=to_date,
        user=user,
    )
    studio_other_income = to_money(sum((income for income, _expense in studio.values()), ZERO))
    studio_cost = to_money(sum((expense for _income, expense in studio.values()), ZERO))

    return {
        "order_count": order_count,
        "active_order_count": active_order_count,
        "sold_cost": to_money(sold_cost),
        "in_transit_cost": to_money(in_transit_cost),
        "deposit_held": deposit_held_total(session, user=user),
        "studio_cost": studio_cost,
        "account_sale_profit": to_money(account_sale_profit),
        "studio_other_income": studio_other_income,
        "profit": to_money(account_sale_profit + studio_other_income - studio_cost),
    }
