"""订单详情财务汇总计算。"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from app.shared.order_amounts import order_profit_flow_by_order

from .execution_schemas import (
    ExecutionCashflowOut,
    ExecutionFinanceSummaryOut,
    ExecutionRebateOut,
)


def build_finance_summary(
    db: Session,
    *,
    order_ids: list[int],
    event_cashflows: dict[str, ExecutionCashflowOut],
    order_cashflows: dict[int, list[ExecutionCashflowOut]],
    order_rebates: dict[int, list[ExecutionRebateOut]],
    action_model_rebate_nos: set[str],
    deposit_loss_flow_nos: set[str],
    profit_flows_by_order: dict[int, tuple[Decimal, Decimal]] | None = None,
) -> ExecutionFinanceSummaryOut:
    """按详情明细计算收入、支出与净额。

    押金损失流水不重复计入支出；分期坏账和非现金回收成本从订单利润口径取数。
    """
    zero = Decimal("0.00")
    cashflow_income = zero
    total_expense = zero
    for flow in [*event_cashflows.values(), *[item for flows in order_cashflows.values() for item in flows]]:
        if flow.flow_no in deposit_loss_flow_nos:
            continue
        if flow.direction == "IN":
            cashflow_income += flow.amount
        else:
            total_expense += flow.amount

    rebate_income = sum(
        (
            rebate.amount
            for rebates in order_rebates.values()
            for rebate in rebates
            if rebate.rebate_no not in action_model_rebate_nos
        ),
        zero,
    )
    profit_flows = (profit_flows_by_order if profit_flows_by_order is not None
                    else order_profit_flow_by_order(db, order_ids=order_ids)) if order_ids else {}
    noncash_expense = sum((profit_flows[order_id][1] for order_id in set(order_ids) if order_id in profit_flows), zero)
    total_expense += noncash_expense
    total_income = cashflow_income + rebate_income
    return ExecutionFinanceSummaryOut(
        cashflow_income=cashflow_income,
        rebate_income=rebate_income,
        total_income=total_income,
        total_expense=total_expense,
        net_amount=total_income - total_expense,
    )
