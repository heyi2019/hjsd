"""订单物理删除服务。

订单删除是管理员专属的不可恢复动作，与订单编辑、取消等普通变更隔离，
集中维护所有订单从属数据的清理顺序，并复用库存账号删除口径。
"""

from __future__ import annotations

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


def delete_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> None:
    """物理删除订单及其全部业务从属数据，并同步删除仅被本单使用的库存账号。

    客户、合作方、导入批次等主数据不删除；订单关联的角色、事件、资金流水、
    分润、分期、返点、押金、订单关系和映射全部清理。
    库存账号是独立库存实体：若仍被其他订单引用则拒绝删除，避免连带破坏其他订单。
    """
    order = get_order(session, order_id, user)
    cleaned_reason = reason.strip()
    if not cleaned_reason:
        raise Validation("删除原因不能为空", details={"field": "reason"})

    account_id = order.account_id
    if account_id is not None:
        shared_order = session.scalar(
            select(Order.id)
            .where(Order.account_id == account_id, Order.id != order.id)
            .limit(1)
        )
        if shared_order is not None:
            raise Validation(
                "该库存账号仍被其他订单使用，不能随订单一起删除",
                details={"account_id": account_id, "other_order_id": shared_order},
            )

    event_ids = set(
        session.scalars(
            select(OrderEvent.id).where(OrderEvent.order_id == order.id)
        ).all()
    )
    installment_ids = set(
        session.scalars(
            select(Installment.id).where(Installment.order_id == order.id)
        ).all()
    )
    deposit_ids = set(
        session.scalars(
            select(Deposit.id).where(Deposit.source_order_id == order.id)
        ).all()
    )

    # 冲销流水可能没有 order_id，但会通过 reversal_of_id 继续挂在本单流水上。
    flow_ids = set(
        session.scalars(
            select(Cashflow.id).where(
                or_(
                    Cashflow.order_id == order.id,
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

    # 先清理所有 RESTRICT/非级联的订单从属表，再删除订单主行。
    if flow_ids:
        session.query(Cashflow).filter(Cashflow.id.in_(flow_ids)).delete(
            synchronize_session=False
        )
    if event_ids:
        session.query(OrderEvent).filter(OrderEvent.id.in_(event_ids)).delete(
            synchronize_session=False
        )
    if deposit_ids:
        session.query(Deposit).filter(Deposit.id.in_(deposit_ids)).delete(
            synchronize_session=False
        )
    session.query(OrderProfitAllocation).filter(
        OrderProfitAllocation.order_id == order.id
    ).delete(synchronize_session=False)
    session.query(RebateRecord).filter(
        RebateRecord.source_order_id == order.id
    ).delete(synchronize_session=False)
    if installment_ids:
        session.query(InstallmentDisposition).filter(
            or_(
                InstallmentDisposition.installment_id.in_(installment_ids),
                InstallmentDisposition.related_order_id == order.id,
            )
        ).delete(synchronize_session=False)
        session.query(InstallmentSchedule).filter(
            InstallmentSchedule.installment_id.in_(installment_ids)
        ).delete(synchronize_session=False)
        session.query(Installment).filter(
            Installment.id.in_(installment_ids)
        ).delete(synchronize_session=False)
    session.query(OrderLink).filter(
        or_(OrderLink.source_order_id == order.id, OrderLink.target_order_id == order.id)
    ).delete(synchronize_session=False)
    session.query(OrderCustomerRole).filter(
        OrderCustomerRole.order_id == order.id
    ).delete(synchronize_session=False)
    session.query(OrderCounterpartyRole).filter(
        OrderCounterpartyRole.order_id == order.id
    ).delete(synchronize_session=False)
    session.query(CustomerLead).filter(
        CustomerLead.converted_order_id == order.id
    ).update({CustomerLead.converted_order_id: None}, synchronize_session=False)
    session.query(ImportRow).filter(
        ImportRow.mapped_order_id == order.id
    ).update({ImportRow.mapped_order_id: None}, synchronize_session=False)

    before = {
        "id": order.id,
        "order_no": order.order_no,
        "order_type": order.order_type,
        "account_id": account_id,
        "status": order.status,
        "trade_date": order.trade_date.isoformat(),
        "event_count": len(event_ids),
        "cashflow_count": len(flow_ids),
        "installment_count": len(installment_ids),
    }
    order_no = order.order_no
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

    if account_id is not None:
        # 复用库存中心的账号删除逻辑，确保账号审计和约束校验口径一致。
        from app.stocks.profile import delete_account as stocks_delete_account

        stocks_delete_account(
            session,
            account_id,
            actor=actor,
            reason=f"随订单 {order_no} 删除：{cleaned_reason}",
            user=user,
        )


__all__ = ["delete_order"]
