"""订单详情财务汇总计算。"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from app.orders.amounts import is_deposit_loss_flow, order_profit_flow_by_order

from app.stocks.schemas import (
    ExecutionCashflowOut,
    ExecutionFinanceSummaryOut,
    ExecutionRebateOut,
)


def build_finance_summary(
    db: Session,
    *,
    order_ids: list[int],
    event_cashflows: dict[int, ExecutionCashflowOut],
    order_cashflows: dict[int, list[ExecutionCashflowOut]],
    order_rebates: dict[int, list[ExecutionRebateOut]],
    action_model_rebate_ids: set[int],
    deposit_loss_flow_nos: set[str],
) -> ExecutionFinanceSummaryOut:
    """按详情明细计算收入、支出与净额。

    押金损失流水仍保留在列表中，但不重复计入支出；分期坏账从订单利润口径取数，
    不生成第二笔资金明细。
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
            rebate.base_amount
            for rebates in order_rebates.values()
            for rebate in rebates
            if rebate.id not in action_model_rebate_ids
        ),
        zero,
    )
    bad_debt_expense = sum(
        (
            expense
            for _rebate_income, expense in order_profit_flow_by_order(db, order_ids=order_ids).values()
        ),
        zero,
    ) if order_ids else zero
    total_expense += bad_debt_expense
    total_income = cashflow_income + rebate_income
    return ExecutionFinanceSummaryOut(
        cashflow_income=cashflow_income,
        rebate_income=rebate_income,
        total_income=total_income,
        total_expense=total_expense,
        net_amount=total_income - total_expense,
    )
