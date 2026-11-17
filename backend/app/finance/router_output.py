"""finance.router_output：流水、押金、返点、对账与划转的输出装配。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.shared.operation_operators import list_operation_operators
from app.domain.trade import Deposit, Order, RebateRecord
from app.finance import schemas
from app.shared.form_values import get_extra_values
from app.core.actor import actor_name as _actor


def _cashflow_out(db: Session, flow) -> schemas.CashflowOut:
    def value(key: str):
        if isinstance(flow, dict):
            return flow.get(key)
        if key == "occurred_at":
            return flow.created_at
        return getattr(flow, key)
    nature = value("nature")
    category = value("category")
    direction = value("direction")
    order_id = value("order_id")
    # 列表路径的 flow 来自 service 层 outerjoin 出的 dict，order_no 已在其中，
    # 不必再逐行 db.get(Order)（原实现每页多发 N 条 SQL）。非 dict 入参才回查。
    if isinstance(flow, dict):
        order_no = flow.get("order_no")
    else:
        order = db.get(Order, order_id) if order_id else None
        order_no = order.order_no if order else None
    source = value("source_type")
    return schemas.CashflowOut(
        id=value("id"),
        flow_no=value("flow_no"),
        pool_id=value("pool_id"),
        occurred_on=value("occurred_on"),
        occurred_at=value("occurred_at"),
        nature=nature,
        ledger_type=value("ledger_type"),
        accounting_attribute=value("accounting_attribute"),
        category=category,
        direction=direction,
        amount=value("amount"),
        source_type=value("source_type"),
        source_id=value("source_id"),
        reviewed_by=value("reviewed_by"),
        reviewed_at=value("reviewed_at"),
        order_id=order_id,
        order_no=order_no,
        source=source,
        note=value("note"),
        form_extra=value("form_extra"),
        operator=(value("operator") or value("created_by"))
        if isinstance(flow, dict)
        else flow.created_by,
        operator_user_ids=value("operator_user_ids"),
        extra_values=get_extra_values(
            db, entity_type="cashflow", entity_id=value("id")
        ),
    )


def _deposit_out(item: Deposit, db: Session | None = None) -> schemas.DepositOut:
    operation_operators = list_operation_operators(
        db, entity_type="deposit", entity_id=item.id
    ) if db is not None else []
    return schemas.DepositOut.model_validate(
        {
            **vars(item),
            "created_at": item.created_at,
            "operator": item.created_by,
            "operation_operators": operation_operators,
        }
    )


def _rebate_out(item: RebateRecord) -> schemas.RebateOut:
    payload = {
        **vars(item),
        "created_at": item.created_at,
        "operator": item.created_by,
        "operator_user_ids": item.operator_user_ids,
    }
    return schemas.RebateOut.model_validate(payload)


def _reconciliation_out(item, db: Session | None = None) -> schemas.ReconciliationOut:
    return schemas.ReconciliationOut.model_validate(
        {
            **vars(item),
            "created_at": item.created_at,
            "operator": item.created_by,
            "operation_operators": list_operation_operators(
                db, entity_type="reconciliation", entity_id=item.id
            ) if db is not None else [],
        }
    )


def _transfer_out(db: Session, result: dict) -> schemas.TransferOut:
    flows = result["cashflows"]
    first_flow = min(flows, key=lambda flow: flow.created_at)
    return schemas.TransferOut(
        transfer_id=result["transfer_id"],
        source_pool_id=result["source_pool_id"],
        target_pool_id=result["target_pool_id"],
        amount=result["amount"],
        occurred_on=result["occurred_on"],
        created_at=first_flow.created_at,
        operator=first_flow.created_by,
        operation_operators=list_operation_operators(
            db, entity_type="transfer", entity_id=result["transfer_id"]
        ),
        cashflows=[_cashflow_out(db, flow) for flow in flows],
    )

__all__ = [
    "_actor",
    "_cashflow_out",
    "_deposit_out",
    "_rebate_out",
    "_reconciliation_out",
    "_transfer_out",
]
