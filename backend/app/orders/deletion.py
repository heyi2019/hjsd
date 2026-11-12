"""订单删除服务。

订单删除是管理员专属的不可恢复动作，与订单编辑、取消等普通变更隔离。
本模块只负责订单及其从属数据；库存删除由 ``stocks.deletion`` 负责，
两者通过显式参数联动，避免循环删除和部分清理。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import AuditAction
from app.domain.imports import ImportRow
from app.domain.parties import CustomerLead, OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import (
    Cashflow,
    Deposit,
    Installment,
    InstallmentDisposition,
    InstallmentSchedule,
    Order,
    OrderEvent,
    OrderLink,
    OrderProfitAllocation,
    RebateRecord,
)

from ._shared import get_order


@dataclass(frozen=True)
class _OrderDependencies:
    """删除订单前收集的从属主键，用于清理和审计快照共用。"""

    event_ids: set[int]
    installment_ids: set[int]
    deposit_ids: set[int]
    cashflow_ids: set[int]


def delete_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
    delete_inventory_after: bool = True,
) -> None:
    """删除订单及其全部从属数据，并按需删除关联库存。

    订单删除会清理事件、资金流水、分润、分期、返点、押金、订单关系和导入映射。
    默认同步删除仅被本单使用的库存；库存中心批量删除订单时关闭该分支，
    待所有关联订单清理完后再由库存服务统一删除库存。
    """
    order = get_order(session, order_id, user)
    cleaned_reason = _clean_reason(reason)
    inventory_id = order.account_id
    if inventory_id is not None and delete_inventory_after:
        _ensure_inventory_not_shared(session, order.id, inventory_id)

    dependencies = _collect_dependencies(session, order.id)
    _delete_order_dependents(session, order.id, dependencies)

    order_no = order.order_no
    before = _order_snapshot(order, dependencies)
    session.delete(order)
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_DELETE,
        entity_type="order",
        entity_id=order_no,
        actor=actor,
        before=before,
        reason=cleaned_reason,
    )

    if inventory_id is not None and delete_inventory_after:
        # 延迟导入避免 orders.deletion 与 stocks.deletion 的模块级循环依赖。
        from app.stocks.deletion import delete_inventory

        delete_inventory(
            session,
            inventory_id,
            actor=actor,
            reason=f"随订单 {order_no} 删除：{cleaned_reason}",
            user=user,
        )


def _clean_reason(reason: str) -> str:
    cleaned = reason.strip()
    if not cleaned:
        raise Validation("删除原因不能为空", details={"field": "reason"})
    return cleaned


def _ensure_inventory_not_shared(session: Session, order_id: int, inventory_id: int) -> None:
    shared_order = session.scalar(
        select(Order.id)
        .where(Order.account_id == inventory_id, Order.id != order_id)
        .limit(1)
    )
    if shared_order is not None:
        raise Validation(
            "该库存仍被其他订单使用，不能随订单一起删除",
            details={"account_id": inventory_id, "other_order_id": shared_order},
        )


def _collect_dependencies(session: Session, order_id: int) -> _OrderDependencies:
    event_ids = set(
        session.scalars(select(OrderEvent.id).where(OrderEvent.order_id == order_id)).all()
    )
    installment_ids = set(
        session.scalars(select(Installment.id).where(Installment.order_id == order_id)).all()
    )
    deposit_ids = set(
        session.scalars(select(Deposit.id).where(Deposit.source_order_id == order_id)).all()
    )
    cashflow_ids = _collect_cashflow_ids(
        session,
        order_id=order_id,
        event_ids=event_ids,
        deposit_ids=deposit_ids,
    )
    return _OrderDependencies(
        event_ids=event_ids,
        installment_ids=installment_ids,
        deposit_ids=deposit_ids,
        cashflow_ids=cashflow_ids,
    )


def _collect_cashflow_ids(
    session: Session,
    *,
    order_id: int,
    event_ids: set[int],
    deposit_ids: set[int],
) -> set[int]:
    # 冲销流水可能没有 order_id，但会通过 reversal_of_id 继续挂在本单流水上。
    flow_ids = set(
        session.scalars(
            select(Cashflow.id).where(
                or_(
                    Cashflow.order_id == order_id,
                    Cashflow.order_event_id.in_(event_ids) if event_ids else False,
                    Cashflow.deposit_id.in_(deposit_ids) if deposit_ids else False,
                )
            )
        ).all()
    )
    while flow_ids:
        child_ids = set(
            session.scalars(
                select(Cashflow.id).where(Cashflow.reversal_of_id.in_(flow_ids))
            ).all()
        ) - flow_ids
        if not child_ids:
            break
        flow_ids.update(child_ids)
    return flow_ids


def _delete_order_dependents(
    session: Session,
    order_id: int,
    dependencies: _OrderDependencies,
) -> None:
    """按 RESTRICT 外键顺序删除订单从属数据。"""
    if dependencies.cashflow_ids:
        session.query(Cashflow).filter(
            Cashflow.id.in_(dependencies.cashflow_ids)
        ).delete(synchronize_session=False)
    if dependencies.event_ids:
        session.query(OrderEvent).filter(
            OrderEvent.id.in_(dependencies.event_ids)
        ).delete(synchronize_session=False)
    if dependencies.deposit_ids:
        session.query(Deposit).filter(
            Deposit.id.in_(dependencies.deposit_ids)
        ).delete(synchronize_session=False)

    session.query(OrderProfitAllocation).filter(
        OrderProfitAllocation.order_id == order_id
    ).delete(synchronize_session=False)
    session.query(RebateRecord).filter(
        RebateRecord.source_order_id == order_id
    ).delete(synchronize_session=False)

    if dependencies.installment_ids:
        session.query(InstallmentDisposition).filter(
            or_(
                InstallmentDisposition.installment_id.in_(dependencies.installment_ids),
                InstallmentDisposition.related_order_id == order_id,
            )
        ).delete(synchronize_session=False)
        session.query(InstallmentSchedule).filter(
            InstallmentSchedule.installment_id.in_(dependencies.installment_ids)
        ).delete(synchronize_session=False)
        session.query(Installment).filter(
            Installment.id.in_(dependencies.installment_ids)
        ).delete(synchronize_session=False)

    session.query(OrderLink).filter(
        or_(OrderLink.source_order_id == order_id, OrderLink.target_order_id == order_id)
    ).delete(synchronize_session=False)
    session.query(OrderCustomerRole).filter(
        OrderCustomerRole.order_id == order_id
    ).delete(synchronize_session=False)
    session.query(OrderCounterpartyRole).filter(
        OrderCounterpartyRole.order_id == order_id
    ).delete(synchronize_session=False)
    session.query(CustomerLead).filter(
        CustomerLead.converted_order_id == order_id
    ).update({CustomerLead.converted_order_id: None}, synchronize_session=False)
    session.query(ImportRow).filter(
        ImportRow.mapped_order_id == order_id
    ).update({ImportRow.mapped_order_id: None}, synchronize_session=False)


def _order_snapshot(order: Order, dependencies: _OrderDependencies) -> dict[str, object]:
    return {
        "id": order.id,
        "order_no": order.order_no,
        "order_type": order.order_type,
        "account_id": order.account_id,
        "status": order.status,
        "trade_date": order.trade_date.isoformat(),
        "event_count": len(dependencies.event_ids),
        "cashflow_count": len(dependencies.cashflow_ids),
        "installment_count": len(dependencies.installment_ids),
    }


__all__ = ["delete_order"]
