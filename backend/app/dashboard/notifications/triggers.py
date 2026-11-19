"""notifications.triggers：业务动作 → 用户通知的编排（SYS-01-04）。

利润分配配置提醒两段式：
  ① 售出完成 → 通知本次 SELL 事件执行人「去配置分润」（PROFIT_PENDING，待办提醒）；
  ② 分润配置保存完成 → 通知利润接收人「分润已配置」（PROFIT_ALLOCATED，结果通知）。

售出事件每次生成新的待办并关闭同一接收人的旧待办；其他重复触发按
recipient + type + entity 去重。本模块只做「谁该收到什么」的映射，不承载业务事实。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import now_second
from app.domain.enums import OrderStatus
from app.domain.notifications import Notification
from app.domain.trade import Order, OrderEvent, OrderProfitAllocation
from app.domain.users import User

from .service import PROFIT_ALLOCATED, PROFIT_PENDING, create_notification, ensure_notification


def _valid_user_ids(session: Session, candidates: set[int]) -> set[int]:
    """过滤出真实在册用户，避免历史脏 id 让通知落空或触发外键问题。"""
    if not candidates:
        return set()
    return set(session.scalars(select(User.id).where(User.id.in_(candidates))).all())


def close_pending_profit_for_order(session: Session, order: Order, *, actor: str) -> None:
    """售出取消后关闭该订单所有尚未处理的分润待办。"""
    notifications = session.scalars(select(Notification).where(
        Notification.notification_type == PROFIT_PENDING,
        Notification.entity_type == "order",
        Notification.entity_id == order.order_no,
        Notification.read_at.is_(None),
    )).all()
    for notification in notifications:
        notification.read_at = now_second()
        notification.updated_by = actor


def notify_seller_to_allocate(
    session: Session, order: Order, event: OrderEvent, *, actor: str, new_sale: bool = False
) -> int:
    """段①：售出闭环后提醒本次 SELL 执行人去配置分润，返回新建条数。

    收件人优先取事件上的多操作人 `operator_user_ids`（前端售出表单的「操作人」），
    为空时回退到事件登记人 actor 对应的用户 id。
    """
    if order.status != OrderStatus.COMPLETED.value:
        return 0
    candidates = {
        int(uid)
        for uid in (event.operator_user_ids or [])
        if isinstance(uid, int) and not isinstance(uid, bool) and uid > 0
    }
    if not candidates:
        actor_id = session.scalar(select(User.id).where(User.username == actor))
        if actor_id is not None:
            candidates.add(int(actor_id))
    created = 0
    for uid in sorted(_valid_user_ids(session, candidates)):
        if new_sale:
            # 每次真实售出都是新的待办；旧提醒保留历史，但不再重复计入未读。
            previous = session.scalars(select(Notification).where(
                Notification.recipient_user_id == uid,
                Notification.notification_type == PROFIT_PENDING,
                Notification.entity_type == "order",
                Notification.entity_id == order.order_no,
                Notification.read_at.is_(None),
            )).all()
            for notification in previous:
                notification.read_at = now_second()
                notification.updated_by = actor
            create_notification(
                session, recipient_user_id=uid, notification_type=PROFIT_PENDING,
                title="订单分润待配置", message=f"订单 {order.order_no} 已售出完成，请前往配置分润。",
                entity_type="order", entity_id=order.order_no, actor=actor,
            )
            created += 1
            continue
        _row, is_new = ensure_notification(
            session,
            recipient_user_id=uid,
            notification_type=PROFIT_PENDING,
            title="订单分润待配置",
            message=f"订单 {order.order_no} 已售出完成，请前往配置分润。",
            entity_type="order",
            entity_id=order.order_no,
            actor=actor,
        )
        created += int(is_new)
    return created


def notify_profit_recipients(session: Session, order: Order, *, actor: str) -> int:
    """段②：分润配置保存后通知利润接收人（排除公司归属），返回新建条数。

    仅在订单已 COMPLETED 时发送；分润配置入口本身也只接受已售订单。
    """
    if order.status != OrderStatus.COMPLETED.value:
        return 0
    rows = session.scalars(
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order.id)
    ).all()
    created = 0
    for row in rows:
        if row.user_id is None or (row.allocation_type or "").upper() == "COMPANY":
            continue  # 公司归属不绑定人员，不通知
        _row, is_new = ensure_notification(
            session,
            recipient_user_id=row.user_id,
            notification_type=PROFIT_ALLOCATED,
            title="订单分润已配置",
            message=f"订单 {order.order_no} 分润配置已保存，请到收益明细查看。",
            entity_type="order",
            entity_id=order.order_no,
            actor=actor,
        )
        created += int(is_new)
    return created


__all__ = [
    "PROFIT_ALLOCATED",
    "PROFIT_PENDING",
    "notify_profit_recipients",
    "notify_seller_to_allocate",
]
