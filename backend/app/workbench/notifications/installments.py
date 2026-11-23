"""为当前用户生成可见分期合约的逾期提醒。"""
from __future__ import annotations

from datetime import date

from sqlalchemy import String, cast, exists, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser, PERM_FINANCE_READ, PERM_ORDER_CREATE
from app.domain.enums import InstallmentContractType, InstallmentStatus
from app.domain.notifications import Notification
from app.domain.trade import Installment, InstallmentSchedule, Order
from app.shared.scope import owner_scope_filter
from app.workbench.reminder_config import read_reminder_config
from app.workbench.notifications.service import INSTALLMENT_OVERDUE
from ._writes import add_numbered_notifications, lock_recipient


def sync_overdue_installment_notifications_for_user(
    db: Session, user: CurrentUser, *, as_of: date | None = None,
) -> int:
    """对每个未偿逾期期次生成一次提醒，保留已有通知。"""
    if not user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ)):
        return 0

    # 与同用户同步和已读操作串行，允许通知外键的 KEY SHARE 锁。
    lock_recipient(db, user.id)
    if not read_reminder_config(db)["overdue_installments_enabled"]:
        return 0

    notified = exists(select(Notification.id).where(
        Notification.recipient_user_id == user.id,
        Notification.notification_type == INSTALLMENT_OVERDUE,
        Notification.entity_type == "installment_schedule",
        Notification.entity_id == cast(InstallmentSchedule.id, String),
    ))
    stmt = (
        select(InstallmentSchedule, Installment, Order)
        .join(Installment, Installment.id == InstallmentSchedule.installment_id)
        .join(Order, Order.id == Installment.order_id)
        .where(
            Installment.contract_type == InstallmentContractType.STOCK_SALE.value,
            Installment.status.in_((InstallmentStatus.PENDING.value, InstallmentStatus.ACTIVE.value, InstallmentStatus.OVERDUE.value)),
            InstallmentSchedule.due_on < (as_of or date.today()),
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount < InstallmentSchedule.due_amount,
            ~notified,
        )
        .order_by(InstallmentSchedule.id)
    )
    scope = owner_scope_filter(Order.owner_id, user, db)
    if scope is not None:
        stmt = stmt.where(scope)
    rows = db.execute(stmt).all()
    records = [(str(schedule.id),
                f"订单 {order.order_no} · 合约 {contract.inst_no} · 第 {schedule.period_no} 期"
                f" · 到期日 {schedule.due_on} · 待还 {to_money(schedule.due_amount - schedule.received_amount - schedule.waived_amount)}")
               for schedule, contract, order in rows]
    return add_numbered_notifications(db, user_id=user.id, notification_type=INSTALLMENT_OVERDUE,
                                      title="分期逾期提醒", entity_type="installment_schedule", records=records)
