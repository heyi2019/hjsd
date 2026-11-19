"""订单详情中的执行事件编辑。"""
from __future__ import annotations

from decimal import Decimal

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import Account, Cashflow, Installment, OrderEvent, RebateRecord, Reconciliation
from app.domain.enums import CashflowSourceType
from app.domain.users import User
from app.shared.order_access import get_order
from app.business.events import post_event
from app.business.listing_state import active_listings

from .schemas import ExecutionEditItem, ExecutionEditRequest, ExecutionOperationCreateItem


def _linked_unlistings(db: Session, listing: OrderEvent) -> list[OrderEvent]:
    events = db.scalars(select(OrderEvent).where(
        OrderEvent.order_id == listing.order_id,
        OrderEvent.event_type == "OPERATE",
        OrderEvent.is_posted.is_(True),
    ).with_for_update()).all()
    return [event for event in events if (event.form_extra or {}).get("operation_type") == "UNLIST"
        and str((event.form_extra or {}).get("consignment_event_id") or "") == str(listing.id)]


def apply_operation_event_creates(
    db: Session,
    order_id: int,
    items: list[ExecutionOperationCreateItem],
    actor: str,
    user: CurrentUser,
) -> None:
    """把编辑态补录的运营动作落为正式事件，并保留用户选择的时间。"""
    for item in items:
        occurred_at = item.occurred_at.replace(tzinfo=None)
        form_extra = dict(item.form_extra or {})
        if item.operation_type == "CONSIGNMENT":
            form_extra["listed_at"] = occurred_at.isoformat()
            form_extra_scope = "CONSIGN"
        elif item.operation_type == "UNLIST":
            if form_extra.get("platform_unlist_scope") != "SYSTEM":
                platforms = form_extra.get("consignment_platforms")
                listing_id = form_extra.get("consignment_event_id")
                if not isinstance(listing_id, int) or isinstance(listing_id, bool) or not isinstance(platforms, list) or len(platforms) != 1 or not isinstance(platforms[0], str) or (listing_id, platforms[0].strip()) not in active_listings(db, order_id):
                    raise Validation("请选择当前订单仍在上架的具体平台记录")
                form_extra["platform_unlist_scope"] = "PLATFORM"
                form_extra["consignment_platforms"] = [platforms[0].strip()]
            form_extra["platform_unlisted_at"] = occurred_at.isoformat()
            form_extra_scope = "INVOID"
        else:
            form_extra_scope = "INVEDIT"
        event, _ = post_event(
            db,
            order_id,
            event_type="OPERATE",
            operation_type=item.operation_type,
            amount=0,
            occurred_on=occurred_at.date(),
            actor=actor,
            operator_user_ids=item.operator_user_ids,
            form_extra=form_extra,
            form_extra_scope=form_extra_scope,
            user=user,
        )
        # post_event 的 posted_at 是登记时间；详情编辑必须使用用户选定的运营时间。
        event.occurred_on = occurred_at.date()
        event.posted_at = occurred_at
        event.updated_by = actor


def validate_event_edits(
    db: Session,
    account: Account,
    order_id: int,
    payload: ExecutionEditRequest,
    user: CurrentUser,
) -> tuple[list[tuple[OrderEvent, Cashflow | None, ExecutionEditItem]], Decimal]:
    changes: list[tuple[OrderEvent, Cashflow | None, ExecutionEditItem]] = []
    cost_delta = Decimal("0")
    requested_operator_ids = {
        operator_id
        for item in payload.events
        for operator_id in (item.operator_user_ids or [])
    }
    active_operator_ids = set(db.scalars(
        select(User.id).where(User.id.in_(requested_operator_ids), User.is_active.is_(True))
    ).all()) if requested_operator_ids else set()
    for item in payload.events:
        event = db.scalar(select(OrderEvent).where(OrderEvent.id == item.id).with_for_update())
        order = get_order(db, event.order_id, user) if event else None
        if event is None or order is None or order.id != order_id or order.account_id != account.id or not event.is_posted:
            raise NotFound("执行记录不存在")
        if Decimal(str(event.amount)) != item.expected_amount:
            raise Conflict("执行记录已被修改，请刷新后重试")
        original_extra = event.form_extra or {}
        if event.event_type == "OPERATE" and original_extra.get("operation_type") and item.form_extra is not None and item.form_extra.get("operation_type") != original_extra.get("operation_type"):
            raise Validation("运营记录的动作类型不能直接修改")
        if event.event_type == "OPERATE" and original_extra.get("operation_type") == "UNLIST" and (original_extra.get("consignment_event_id") is not None or original_extra.get("platform_unlist_scope") == "SYSTEM") and item.form_extra is not None:
            protected = ("operation_type", "consignment_event_id", "consignment_platforms", "platform_unlist_scope")
            if any(item.form_extra.get(key) != original_extra.get(key) for key in protected):
                raise Validation("已关联上架记录的下架平台及范围不能直接修改")
        if event.event_type == "OPERATE" and original_extra.get("operation_type") == "UNLIST" and original_extra.get("platform_unlist_scope") != "SYSTEM" and item.form_extra is not None and item.form_extra.get("platform_unlist_scope") == "SYSTEM":
            raise Validation("本系统下架请通过下架操作执行")
        if event.event_type == "OPERATE" and (event.form_extra or {}).get("operation_type") == "CONSIGNMENT" and item.form_extra is not None:
            old_platforms = (event.form_extra or {}).get("consignment_platforms") or []
            new_platforms = item.form_extra.get("consignment_platforms") or []
            if old_platforms != new_platforms:
                active = active_listings(db, order_id)
                other_active = {platform for listing_id, platform in active if listing_id != event.id}
                active_ids = {listing_id for listing_id, _ in active}
                for other in payload.events:
                    if other.id != event.id and other.id in active_ids and other.form_extra is not None:
                        proposed = other.form_extra.get("consignment_platforms")
                        if isinstance(proposed, list):
                            other_active.update(value.strip() for value in proposed if isinstance(value, str) and value.strip())
                if isinstance(new_platforms, list) and any(isinstance(platform, str) and platform.strip() in other_active for platform in new_platforms):
                    raise Validation("该平台已上架，请先下架后再重新上架")
                linked = _linked_unlistings(db, event)
                if linked and (len(old_platforms) != 1 or len(new_platforms) != 1):
                    raise Validation("已有下架记录的多平台上架不能直接修改平台，请先核对历史记录")
                if linked and any(other.id in {e.id for e in linked} for other in payload.events):
                    raise Validation("修改上架平台时不能同时编辑关联下架记录，请分开保存")
        if item.operator_user_ids is not None:
            ids = item.operator_user_ids
            if len(set(ids)) != len(ids):
                raise Validation("操作人不能重复选择")
            if not set(ids).issubset(active_operator_ids):
                raise Validation("所选操作人不存在或已停用")
        flow = db.scalar(select(Cashflow).where(
            Cashflow.source_type == CashflowSourceType.ORDER_EVENT.value,
            Cashflow.source_id == event.event_no,
        ).with_for_update())
        if flow is not None and not user.can_see_pool(flow.pool_id):
            raise NotFound("关联资金流水不存在")
        if item.amount == Decimal(str(event.amount)):
            changes.append((event, flow, item))
            continue
        if event.event_type not in {"BUY", "SELL"} or item.amount <= 0:
            raise Validation("该类型执行记录暂不支持修改金额")
        if flow is None:
            raise NotFound("关联资金流水不存在")
        if Decimal(str(flow.amount)) != Decimal(str(event.amount)):
            raise Validation("执行记录与关联流水金额不一致，请先核对")
        if (
            event.offset_event_id is not None
            or flow.source_type == CashflowSourceType.REVERSAL.value
            or db.scalar(select(OrderEvent.id).where(OrderEvent.offset_event_id == event.id)) is not None
            or db.scalar(select(Cashflow.id).where(
                Cashflow.source_type == CashflowSourceType.REVERSAL.value,
                Cashflow.source_id == flow.flow_no,
            )) is not None
        ):
            raise Validation("已冲销或被冲销的记录不能直接修改")
        if db.scalar(select(Installment.id).where(Installment.order_id == order.id)) is not None:
            raise Validation("关联分期的记录不能直接修改，请先处理分期")
        if db.scalar(select(RebateRecord.id).where(RebateRecord.source_order_id == order.id)) is not None:
            raise Validation("关联返点的记录不能直接修改，请先核对返点")
        if db.scalar(select(Reconciliation.id).where(Reconciliation.pool_id == flow.pool_id, Reconciliation.reconciled_on >= flow.occurred_on)) is not None:
            raise Validation("资金账户已有后续对账记录，不能直接修改")
        if event.event_type == "BUY":
            cost_delta += item.amount - Decimal(str(event.amount))
        changes.append((event, flow, item))
    if Decimal(str(account.cost_amount)) + cost_delta < 0:
        raise Validation("修改后库存成本不能为负数")
    return changes, cost_delta


def apply_event_edits(db: Session, changes: list[tuple[OrderEvent, Cashflow | None, ExecutionEditItem]], actor: str) -> None:
    for event, flow, item in changes:
        occurred_at = event.posted_at or event.created_at
        before = {
            "amount": str(event.amount),
            "note": event.note,
            "occurred_at": occurred_at.isoformat() if occurred_at else None,
            "operator_user_ids": event.operator_user_ids,
            "form_extra": jsonable_encoder(event.form_extra),
            "flow_amount": str(flow.amount) if flow else None,
            "flow_note": flow.note if flow else None,
            "flow_operator_user_ids": flow.operator_user_ids if flow else None,
        }
        amount_changed = item.amount != Decimal(str(event.amount))
        event.amount = item.amount
        if "note" in item.model_fields_set:
            event.note = item.note
        if item.occurred_at is not None:
            occurred_at = item.occurred_at.replace(tzinfo=None)
            event.occurred_on = occurred_at.date()
            event.posted_at = occurred_at
            operation_type = (event.form_extra or {}).get("operation_type")
            if event.event_type == "OPERATE" and operation_type == "CONSIGNMENT":
                event.form_extra = {**(event.form_extra or {}), "listed_at": occurred_at.isoformat()}
            elif event.event_type == "OPERATE" and operation_type == "UNLIST":
                event.form_extra = {**(event.form_extra or {}), "platform_unlisted_at": occurred_at.isoformat()}
            if flow is not None:
                flow.occurred_on = occurred_at.date()
                flow.created_at = occurred_at
        if item.form_extra is not None:
            old_extra = event.form_extra or {}
            old_platforms = old_extra.get("consignment_platforms") or []
            new_platforms = item.form_extra.get("consignment_platforms") or []
            if event.event_type == "OPERATE" and old_extra.get("operation_type") == "CONSIGNMENT" and old_platforms != new_platforms and len(old_platforms) == len(new_platforms) == 1:
                for linked in _linked_unlistings(db, event):
                    linked_extra = linked.form_extra or {}
                    platforms = linked_extra.get("consignment_platforms") or []
                    old_platform = old_platforms[0].strip() if isinstance(old_platforms[0], str) else old_platforms[0]
                    new_platform = new_platforms[0].strip() if isinstance(new_platforms[0], str) else new_platforms[0]
                    if any((value.strip() if isinstance(value, str) else value) == old_platform for value in platforms):
                        before_extra = jsonable_encoder(linked_extra)
                        linked.form_extra = {**linked_extra, "consignment_platforms": [new_platform if (value.strip() if isinstance(value, str) else value) == old_platform else value for value in platforms]}
                        linked.updated_by = actor
                        record_audit(db, action="ORDER_UPDATE", entity_type="inventory_event_edit", entity_id=linked.id,
                            actor=actor, before={"form_extra": before_extra}, after={"form_extra": jsonable_encoder(linked.form_extra)})
            # 前端提交的是该事件当前完整草稿；使用替换才能真正删除已清空的平台、价格等字段。
            event.form_extra = item.form_extra
            # 同时修改平台与时间时，时间字段仍以时间控件为准，避免完整草稿里的旧值覆盖新时间。
            if item.occurred_at is not None:
                operation_type = (event.form_extra or {}).get("operation_type")
                if event.event_type == "OPERATE" and operation_type == "CONSIGNMENT":
                    event.form_extra = {**(event.form_extra or {}), "listed_at": occurred_at.isoformat()}
                elif event.event_type == "OPERATE" and operation_type == "UNLIST":
                    event.form_extra = {**(event.form_extra or {}), "platform_unlisted_at": occurred_at.isoformat()}
        if item.operator_user_ids is not None:
            event.operator_user_ids = item.operator_user_ids
            if flow is not None:
                flow.operator_user_ids = item.operator_user_ids
                flow.updated_by = actor
        event.updated_by = actor
        if flow is not None and amount_changed:
            flow.amount = item.amount
            flow.updated_by = actor
        record_audit(
            db,
            action="ORDER_UPDATE",
            entity_type="inventory_event_edit",
            entity_id=event.id,
            actor=actor,
            before=before,
            after={
                "amount": str(item.amount),
                "note": event.note,
                "occurred_at": (event.posted_at or event.created_at).isoformat()
                if event.posted_at or event.created_at
                else None,
                "operator_user_ids": event.operator_user_ids,
                "form_extra": jsonable_encoder(event.form_extra),
                "flow_amount": str(flow.amount) if flow else None,
                "flow_note": flow.note if flow else None,
                "flow_operator_user_ids": flow.operator_user_ids if flow else None,
            },
        )
