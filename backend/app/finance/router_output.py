"""finance.router_output：流水、押金、返点、对账与划转的输出装配。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.operation_operators import list_operation_operators
from app.domain.trade import Cashflow, Deposit, Order, RebateRecord
from app.domain.foundation import BusinessOperationOperator
from app.domain.users import User
from app.domain.enums import CashflowSourceType
from app.finance import schemas
from app.shared.form_values import get_extra_values
from app.core.actor import actor_name as _actor


def _cashflow_outputs(db: Session, flows: list) -> list[schemas.CashflowOut]:
    numbers = [flow.get("flow_no") if isinstance(flow, dict) else flow.flow_no for flow in flows]
    operator_ids = {
        user_id for flow in flows
        for user_id in ((flow.get("operator_user_ids") if isinstance(flow, dict) else flow.operator_user_ids) or [])
    }
    operator_names = {
        user.id: user.display_name or user.username
        for user in db.scalars(select(User).where(User.id.in_(operator_ids))).all()
    } if operator_ids else {}
    reversed_numbers = set(db.scalars(select(Cashflow.source_id).where(
        Cashflow.source_type == CashflowSourceType.REVERSAL.value,
        Cashflow.source_id.in_(numbers),
    )).all()) if numbers else set()
    return [_cashflow_out(db, flow, reversed_numbers=reversed_numbers, operator_names=operator_names) for flow in flows]


def _cashflow_out(db: Session, flow, *, reversed_numbers: set | None = None, operator_names: dict[int, str] | None = None) -> schemas.CashflowOut:
    def value(key: str):
        if isinstance(flow, dict):
            return flow.get(key)
        if key == "occurred_at":
            return flow.created_at
        return getattr(flow, key)
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
    operator_ids = value("operator_user_ids") or []
    if operator_names is None:
        operator_names = {
            user.id: user.display_name or user.username
            for user in db.scalars(select(User).where(User.id.in_(operator_ids))).all()
        } if operator_ids else {}
    operator = "、".join(operator_names.get(user_id, f"用户 {user_id}") for user_id in operator_ids)
    if not operator:
        operator = (value("operator") or value("created_by")) if isinstance(flow, dict) else flow.created_by
    if reversed_numbers is None:
        reversed_numbers = set(db.scalars(select(Cashflow.source_id).where(
            Cashflow.source_type == CashflowSourceType.REVERSAL.value,
            Cashflow.source_id == value("flow_no"),
        )).all())
    return schemas.CashflowOut(
        id=value("id"),
        flow_no=value("flow_no"),
        pool_id=value("pool_id"),
        occurred_on=value("occurred_on"),
        occurred_at=value("occurred_at"),
        ledger_type=value("ledger_type"),
        accounting_attribute=value("accounting_attribute"),
        category=category,
        direction=direction,
        amount=value("amount"),
        source_type=value("source_type"),
        source_id=value("source_id"),
        is_reversed=value("flow_no") in reversed_numbers,
        reviewed_by=value("reviewed_by"),
        reviewed_at=value("reviewed_at"),
        order_id=order_id,
        order_no=order_no,
        source=source,
        note=value("note"),
        form_extra=value("form_extra"),
        operator=operator,
        operator_user_ids=value("operator_user_ids"),
        extra_values=get_extra_values(
            db, entity_type="cashflow", entity_id=value("id")
        ),
    )


def _deposit_action_histories(db: Session, deposit_ids: list[int]) -> dict[str, list[schemas.DepositActionOut]]:
    if not deposit_ids:
        return {}
    rows = db.scalars(select(Cashflow).where(
        Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
        Cashflow.source_id.in_([str(deposit_id) for deposit_id in deposit_ids]),
    ).order_by(Cashflow.id)).all()
    histories: dict[str, list[schemas.DepositActionOut]] = {}
    for flow in rows:
        action = {"DEPOSIT_HOLD": "HOLD", "DEPOSIT_RELEASE": "RETURN", "DEPOSIT_CANCEL": "CANCEL"}.get(flow.category)
        if action is None and flow.direction == "OUT":
            action = "LOSS"
        if action is None:
            continue
        histories.setdefault(flow.source_id, []).append(schemas.DepositActionOut(
            flow_no=flow.flow_no, action=action, occurred_on=flow.occurred_on,
            amount=flow.amount, operator_user_ids=flow.operator_user_ids or [], operator=flow.created_by,
        ))
    return histories


def _deposit_out(
    item: Deposit, db: Session, *,
    operation_operators: list[BusinessOperationOperator] | None = None,
    action_history: list[schemas.DepositActionOut] | None = None,
) -> schemas.DepositOut:
    if operation_operators is None:
        operation_operators = list_operation_operators(
            db, entity_type="deposit", entity_id=item.id
        )
    if action_history is None:
        action_history = _deposit_action_histories(db, [item.id]).get(str(item.id), [])
    return schemas.DepositOut.model_validate(
        {
            **vars(item),
            "created_at": item.created_at,
            "operator": item.created_by,
            "operation_operators": operation_operators,
            "action_history": action_history,
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


def _reconciliation_out(
    item, db: Session, *,
    operation_operators: list[BusinessOperationOperator] | None = None,
) -> schemas.ReconciliationOut:
    if operation_operators is None:
        operation_operators = list_operation_operators(
            db, entity_type="reconciliation", entity_id=item.id
        )
    return schemas.ReconciliationOut.model_validate(
        {
            **vars(item),
            "created_at": item.created_at,
            "operator": item.created_by,
            "operation_operators": operation_operators,
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
        cashflows=_cashflow_outputs(db, flows),
    )

__all__ = [
    "_actor",
    "_cashflow_out",
    "_cashflow_outputs",
    "_deposit_out",
    "_rebate_out",
    "_reconciliation_out",
    "_transfer_out",
]
