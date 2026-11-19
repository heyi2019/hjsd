"""工作台唯一汇总查询：页面只消费这里定义的聚合口径。"""
from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_REPORT_READ,
    CurrentUser,
)
from app.domain.options import OptionSet
from app.notifications import service as notification_service
from app.orders.queries import order_customer_count, order_status_counts
from app.reporting.r3_commission import r3_commission_reconciliation
from app.stocks.inventory import dashboard_inventory_summary
from app.finance.installments import queries as installment_queries

REMINDER_CODE = "BUSINESS_OVERVIEW_REMINDERS"
DEFAULT_REMINDERS = {
    "inventory_aging_days": 7,
    "profit_notifications_enabled": True,
    "overdue_installments_enabled": True,
}


def _reminder_config(session: Session) -> dict[str, Any]:
    row = session.scalar(select(OptionSet).where(OptionSet.code == REMINDER_CODE))
    values = {item.get("value"): item.get("label") for item in (row.options if row else [])}
    try:
        aging_days = int(values.get("inventory_aging_days", DEFAULT_REMINDERS["inventory_aging_days"]))
        if aging_days <= 0:
            raise ValueError
    except (TypeError, ValueError):
        aging_days = DEFAULT_REMINDERS["inventory_aging_days"]

    def enabled(key: str) -> bool:
        value = values.get(key)
        return DEFAULT_REMINDERS[key] if value is None else str(value).lower() not in {"0", "false", "off", "disabled"}

    return {
        "inventory_aging_days": aging_days,
        "profit_notifications_enabled": enabled("profit_notifications_enabled"),
        "overdue_installments_enabled": enabled("overdue_installments_enabled"),
    }


def dashboard_summary(session: Session, *, user: CurrentUser) -> dict[str, Any]:
    today = date.today()
    month_start = today.replace(day=1)
    reminders = _reminder_config(session)
    can_orders = user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ))
    can_reports = user.has(PERM_REPORT_READ)

    orders = None
    personal_orders = None
    personal_customers = None
    inventory = None
    installments = None
    if can_orders:
        counts = order_status_counts(
            session,
            trade_date_from=month_start,
            trade_date_to=today,
            user=user,
        )
        personal_counts = order_status_counts(
            session,
            trade_date_from=month_start,
            trade_date_to=today,
            user=user,
            mine=True,
        )
        orders = {
            "total_count": sum(counts.values()),
            "completed_count": counts.get("COMPLETED", 0),
            "active_count": counts.get("ACTIVE", 0) + counts.get("INSTALLMENT", 0),
        }
        personal_orders = sum(personal_counts.values())
        personal_customers = order_customer_count(
            session,
            trade_date_from=month_start,
            trade_date_to=today,
            user=user,
            mine=True,
        )
        inventory = dashboard_inventory_summary(
            session,
            reminder_days=reminders["inventory_aging_days"],
            today=today,
            user=user,
        )
        installment_totals = installment_queries.installment_totals(session, user=user)
        installments = {
            "total_count": installment_totals["total_count"],
            "overdue_count": installment_totals["overdue_count"],
        }

    personal_earnings = None
    if can_reports:
        commission = r3_commission_reconciliation(
            session,
            from_date=month_start,
            to_date=today,
            user=user,
            mine=True,
        )
        personal_earnings = commission["total"]["profit_base"]

    return {
        "period": {"from": month_start, "to": today},
        "orders": orders,
        "personal_orders": personal_orders,
        "personal_customers": personal_customers,
        "personal_earnings": personal_earnings,
        "inventory": inventory,
        "installments": installments,
        "notifications": notification_service.unread_profit_counts(
            session, recipient_user_id=user.id
        ),
        "reminders": reminders,
    }
