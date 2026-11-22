"""分润结果查询与按动作汇总（读路径）。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.trade import Order, OrderProfitAllocation

from app.shared.order_access import get_order


def list_allocations(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> list[dict[str, Any]]:
    order = get_order(session, order_id, user)
    return collect_allocations(session, order)


def collect_allocations(session: Session, order: Order) -> list[dict[str, Any]]:
    rows = session.scalars(
        select(OrderProfitAllocation)
        .where(OrderProfitAllocation.order_id == order.id)
        .order_by(OrderProfitAllocation.id)
    ).all()
    total = Decimal("0")
    total_amount = Decimal("0")
    out = []
    for row in rows:
        total += to_money(row.allocation_rate)
        total_amount += to_money(row.allocation_amount)
        out.append(
            {
                "id": row.id,
                "order_id": row.order_id,
                "user_id": row.user_id,
                "role": row.role,
                "allocation_type": row.allocation_type,
                "allocation_rate": str(to_money(row.allocation_rate)),
                "allocation_amount": str(to_money(row.allocation_amount)),
            }
        )
    return [
        {**item, "total_rate": str(total), "total_amount": str(total_amount)}
        for item in out
    ]


def summarize_allocations_by_type(
    items: list[dict[str, Any]],
) -> dict[str, dict[str, Decimal]]:
    """按动作汇总已存分润比例与金额，前端回填表单时不再做数值累加。"""
    totals: dict[str, dict[str, Decimal]] = {}
    valid_types = {"BUY", "SELL", "OPERATION", "COMPANY"}
    for item in items:
        allocation_type = item.get("allocation_type")
        if allocation_type not in valid_types:
            continue
        group = totals.setdefault(
            allocation_type,
            {"allocation_rate": Decimal("0.00"), "allocation_amount": Decimal("0.00")},
        )
        group["allocation_rate"] += to_money(item.get("allocation_rate") or 0)
        group["allocation_amount"] += to_money(item.get("allocation_amount") or 0)
    return totals


__all__ = ["collect_allocations", "list_allocations", "summarize_allocations_by_type"]


def allocation_form_rows(
    items: list[dict[str, Any]],
    candidates: dict[str, list[int]],
    totals: dict[str, dict[str, Decimal]],
    company_rate: Decimal,
) -> list[dict[str, Any]]:
    """按订单执行人和已保存配置准备分润表单，不改写历史记录。"""
    roles = {"BUY": "BUYER", "SELL": "SALES", "OPERATION": "SERVICE", "COMPANY": "OWNER"}
    rows = []
    for kind, default_role in roles.items():
        existing = [item for item in items if item.get("allocation_type") == kind]
        stored = list(dict.fromkeys(item["user_id"] for item in existing
                                   if isinstance(item.get("user_id"), int) and not isinstance(item["user_id"], bool) and item["user_id"] > 0))
        group = totals.get(kind, {})
        rows.append({
            "allocation_type": kind,
            "employee_ids": [] if kind == "COMPANY" else candidates[kind] or stored,
            "role": (existing[0].get("role") if existing else None) or default_role,
            "allocation_rate": str(company_rate) if kind == "COMPANY" else str(group.get("allocation_rate", "")),
            "allocation_amount": "" if kind == "COMPANY" else str(group.get("allocation_amount", "")),
        })
    return rows
