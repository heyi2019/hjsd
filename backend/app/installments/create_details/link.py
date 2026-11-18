"""回收账号出售关联：把新出售事实挂到最近一笔未转售的原分期。"""
from __future__ import annotations

from datetime import date
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.domain.enums import AuditAction, InstallmentDispositionAction
from app.domain.trade import Installment, InstallmentDisposition, Order

def link_recovered_sale(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    note: str | None = None,
) -> InstallmentDisposition | None:
    """把回收账号的新出售事实关联到最近一笔未转售的原分期。"""
    if order.account_id is None:
        return None
    candidates = session.scalars(
        select(InstallmentDisposition)
        .join(Installment, Installment.id == InstallmentDisposition.installment_id)
        .where(
            InstallmentDisposition.account_id == order.account_id,
            InstallmentDisposition.action == InstallmentDispositionAction.RECOVER.value,
            Installment.order_id != order.id,
        )
        .order_by(InstallmentDisposition.occurred_on.desc(), InstallmentDisposition.id.desc())
    ).all()
    if not candidates:
        return None
    # 一次性取「已转售过」的合约集合，避免在 candidates 上逐条 EXISTS（N+1）。
    resold_installment_ids = set(
        session.scalars(
            select(InstallmentDisposition.installment_id).where(
                InstallmentDisposition.action == InstallmentDispositionAction.RESELL.value,
                InstallmentDisposition.installment_id.in_(
                    {candidate.installment_id for candidate in candidates}
                ),
            )
        ).all()
    )
    recovered = next(
        (
            candidate
            for candidate in candidates
            if candidate.installment_id not in resold_installment_ids
        ),
        None,
    )
    if recovered is None:
        return None
    disposition = InstallmentDisposition(
        installment_id=recovered.installment_id,
        account_id=order.account_id,
        action=InstallmentDispositionAction.RESELL.value,
        occurred_on=occurred_on,
        related_order_id=order.id,
        note=note or f"库存中心出售自动关联订单 {order.order_no}",
        created_by=actor,
        updated_by=actor,
    )
    session.add(disposition)
    session.flush()
    installment = session.get(Installment, recovered.installment_id)
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_RESELL,
        entity_type="installment",
        entity_id=installment.inst_no if installment is not None else str(recovered.installment_id),
        actor=actor,
        after={"account_id": order.account_id, "sale_order_id": order.id},
        reason=disposition.note,
    )
    return disposition
