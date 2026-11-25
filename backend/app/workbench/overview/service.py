"""工作台唯一汇总查询：页面只消费这里定义的聚合口径。"""
from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_REPORT_READ,
    CurrentUser,
)
from app.domain.enums import InstallmentContractType
from app.workbench.reminder_config import read_reminder_config
from app.business.orders.queries import order_customer_count, workbench_order_counts
from app.operations.reports.commission import personal_commission_total
from app.business.inventory.inventory import dashboard_inventory_summary
from app.business.installments import queries as installment_queries
from app.shared.business_period import business_period, period_start_day
from app.core.errors import Validation

def workbench_summary(session: Session, *, user: CurrentUser, from_date: date | None = None, to_date: date | None = None, all_time: bool = False) -> dict[str, Any]:
    today = date.today()
    if (all_time and (from_date is not None or to_date is not None)) or (from_date is None) != (to_date is None) or (from_date is not None and to_date is not None and from_date > to_date):
        raise Validation("请选择有效的开始和结束日期")
    period_from, period_to = (None, None) if all_time else (from_date, to_date) if from_date is not None else business_period(today, period_start_day(session))
    reminders = read_reminder_config(session)
    can_orders = user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ))
    can_reports = user.has(PERM_REPORT_READ)

    orders = None
    personal_orders = None
    personal_customers = None
    inventory = None
    installments = None
    if can_orders:
        total_orders, personal_orders = workbench_order_counts(
            session,
            trade_date_from=period_from,
            trade_date_to=period_to,
            user=user,
        )
        orders = {"total_count": total_orders}
        personal_customers = order_customer_count(
            session,
            trade_date_from=period_from,
            trade_date_to=period_to,
            user=user,
            mine=True,
        )
        inventory = dashboard_inventory_summary(
            session,
            reminder_days=reminders["inventory_aging_days"],
            today=today,
            user=user,
        )
        installment_totals = installment_queries.installment_totals(
            session, user=user, contract_type=InstallmentContractType.STOCK_SALE.value,
        )
        installments = {
            "total_count": installment_totals["total_count"],
            "overdue_count": installment_totals["overdue_count"],
        }

    personal_earnings = None
    if can_reports:
        personal_earnings = personal_commission_total(
            session,
            from_date=period_from,
            to_date=period_to,
            user=user,
        )

    return {
        "period": None if all_time else {"from": period_from, "to": period_to},
        "orders": orders,
        "personal_orders": personal_orders,
        "personal_customers": personal_customers,
        "personal_earnings": personal_earnings,
        "inventory": inventory,
        "installments": installments,
    }
