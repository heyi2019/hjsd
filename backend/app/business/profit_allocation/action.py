"""按动作分润写路径：买号/售出/运营/公司四项，收益人绑定动作执行人。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import AllocationRole, AuditAction
from app.domain.trade import Installment, Order, OrderEvent, OrderProfitAllocation
from app.shared.user_identity import user_id_for_actor
from app.domain.users import User

from .action_rows import ACTION_TYPES
from .listing import collect_allocations
from .terms import validate_amount_directions


def _resolve_action_actor_ids(
    session: Session, order: Order
) -> dict[str, list[int]]:
    """动作执行人候选：建单/卖出表单中的业务负责人是业务事实来源；
    没有表单负责人时，再回退到事件 operator_user_ids / created_by。"""
    action_actor_ids: dict[str, list[int]] = {}
    for action_type in ("BUY", "SELL"):
        configured_key = {
            "BUY": "business_responsible_ids",
            "SELL": "sell_delivery_responsible_ids",
        }[action_type]
        configured = [
            int(uid)
            for uid in ((order.form_extra or {}).get(configured_key) or [])
            if isinstance(uid, int) and not isinstance(uid, bool) and uid > 0
        ]
        if configured:
            active_ids = set(
                session.scalars(
                    select(User.id).where(User.id.in_(configured), User.is_active.is_(True))
                ).all()
            )
            if active_ids != set(configured):
                raise Validation(
                    f"{action_type} 动作操作人不存在或已停用，无法绑定收益人",
                    details={"field": configured_key, "user_ids": configured},
                )
            action_actor_ids[action_type] = list(dict.fromkeys(configured))
            continue
        action = session.scalar(
            select(OrderEvent)
            .where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == action_type,
                OrderEvent.is_posted.is_(True),
            )
            .order_by(OrderEvent.id.desc())
        )
        if action is not None:
            candidates = [
                int(uid) for uid in (action.operator_user_ids or []) if uid is not None
            ]
            if candidates:
                existing = set(
                    session.scalars(select(User.id).where(User.id.in_(candidates))).all()
                )
                candidates = [uid for uid in candidates if uid in existing]
            if not candidates:
                actor_id = user_id_for_actor(session, action.created_by)
                if actor_id is None:
                    raise Validation(
                        f"{action_type} 动作执行人不存在，无法绑定收益人",
                        details={"event_id": action.id, "actor": action.created_by},
                    )
                candidates = [int(actor_id)]
            action_actor_ids[action_type] = candidates
        elif action_type == "SELL":
            contract = session.scalar(
                select(Installment).where(
                    Installment.order_id == order.id,
                    Installment.contract_type == "STOCK_SALE",
                    Installment.status != "CANCELLED",
                )
            )
            if contract is not None:
                actor_id = user_id_for_actor(session, contract.created_by)
                if actor_id is None:
                    raise Validation("售出动作执行人不存在，无法绑定收益人")
                action_actor_ids[action_type] = [int(actor_id)]
        elif action_type == "BUY" and order.order_type in {"HS", "TH", "DG"}:
            # 回收、提号、代挂都属于买号业务动作；DG 沿用标准 SELL
            # 资金事件，因此其买号收益人取建单操作人员。
            creator_id = user_id_for_actor(session, order.created_by)
            if creator_id is not None:
                action_actor_ids[action_type] = [int(creator_id)]
    return action_actor_ids


def set_action_allocations(
    session: Session,
    order: Order,
    *,
    items: list[dict[str, Any]],
    actor: str = "system",
) -> list[dict[str, Any]]:
    """整单重设利润分配。**有效比例合计必须为 100%**（BAS-06-03）。"""
    if not items:
        raise Validation("利润分配不能为空", details={"field": "items"})

    normalized_items = items
    total = Decimal("0")
    total_amount = Decimal("0")
    user_ids: set[int] = set()
    allocation_types: set[str] = set()
    # 四类必须齐全，但每个动作可以有多行（一个动作多人时按人数分别录一行，份额均分）。
    if any(not item.get("allocation_type") for item in normalized_items):
        raise Validation("利润分配项必须标注买号、售出、运营或公司归属")
    # 类型合法性先判：否则一个 BAD 会先被「四类不齐全」吞掉，用户看到的不是真实原因。
    for item in normalized_items:
        candidate = str(item["allocation_type"]).upper()
        if candidate not in ACTION_TYPES:
            raise Validation(
                "分配项必须为 BUY、SELL、OPERATION 或 COMPANY；COMPANY 表示公司归属",
                details={"field": "allocation_type", "value": item["allocation_type"]},
            )
    present_types = {str(item["allocation_type"]).upper() for item in normalized_items}
    if present_types != ACTION_TYPES:
        raise Validation("利润分配必须包含买号、售出、运营和公司归属四项")
    action_actor_ids = _resolve_action_actor_ids(session, order)
    action_person_keys: set[tuple[str, int | None]] = set()
    for item in normalized_items:
        rate = to_money(item.get("allocation_rate") or 0)
        amount = to_money(item.get("allocation_amount") or 0)
        if rate < 0 or rate > 100:
            raise Validation("分润比例必须在 0% 到 100% 之间")
        role = str(item.get("role") or "").upper()
        if role not in AllocationRole.values():
            raise Validation(
                f"分配角色必须为 {AllocationRole.values()}",
                details={"field": "role", "value": item.get("role")},
            )
        allocation_type = item.get("allocation_type")
        if allocation_type is not None:
            allocation_type = str(allocation_type).upper()
            if allocation_type not in ACTION_TYPES:
                raise Validation("分配项必须为 BUY、SELL、OPERATION 或 COMPANY；COMPANY 表示公司归属", details={"field": "allocation_type"})
            # 公司归属只能有一行；买号/售出/运营允许多人各占一行，但同一人不可重复。
            if allocation_type == "COMPANY" and allocation_type in allocation_types:
                raise Validation("公司归属只能有一行", details={"allocation_type": allocation_type})
            allocation_types.add(allocation_type)
            person_key = (allocation_type, None if item.get("user_id") is None else int(item["user_id"]))
            if person_key in action_person_keys:
                raise Validation(
                    "同一动作下同一人员不可重复分润",
                    details={"allocation_type": allocation_type, "user_id": person_key[1]},
                )
            action_person_keys.add(person_key)
            if allocation_type == "COMPANY" and item.get("user_id") is not None:
                raise Validation("公司收益不绑定人员", details={"field": "user_id"})
            if allocation_type == "OPERATION" and item.get("user_id") is None:
                raise Validation("人员收益必须绑定人员", details={"field": "user_id"})
            if allocation_type in {"BUY", "SELL"} and allocation_type not in action_actor_ids and item.get("user_id") is not None:
                raise Validation(f"{allocation_type} 收益人必须绑定对应动作执行人", details={"field": "user_id"})
            if allocation_type in {"BUY", "SELL"} and allocation_type in action_actor_ids:
                candidates = action_actor_ids[allocation_type]
                if item.get("user_id") is None:
                    # 只有唯一执行人时自动绑定；多人协作时为每人各录一行，不替用户猜。
                    if len(candidates) == 1:
                        item["user_id"] = candidates[0]
                    else:
                        raise Validation(
                            f"{allocation_type} 有 {len(candidates)} 位执行人，请为每人分别填写分润行",
                            details={"field": "user_id", "allowed_user_ids": candidates},
                        )
                elif int(item["user_id"]) not in candidates:
                    raise Validation(
                        f"{allocation_type} 收益人必须绑定对应动作执行人，且必须是该动作的执行人",
                        details={
                            "field": "user_id",
                            "allowed_user_ids": candidates,
                        },
                    )
        if item.get("user_id") is not None:
            user_ids.add(int(item["user_id"]))
        total += rate
        total_amount += amount

    existing_user_ids = {
        user_id
        for user_id in session.scalars(select(User.id).where(User.id.in_(user_ids))).all()
    }
    missing_user_ids = sorted(user_ids - existing_user_ids)
    if missing_user_ids:
        raise Validation(
            "利润分配人员不存在",
            details={"field": "items.user_id", "missing": missing_user_ids},
        )

    amounts = [to_money(item.get("allocation_amount") or 0) for item in normalized_items]
    if not any(amount != 0 for amount in amounts):
        if total != Decimal("100.00"):
            raise Validation(
                "有效分配比例合计必须为 100%",
                details={"total": str(total), "items": len(items)},
            )
    else:
        from app.shared.order_amounts import order_amounts

        profit = to_money(order_amounts(session, order.id)["PROFIT"])
        validate_amount_directions(amounts, profit)
        if total != 0:
            raise Validation("按金额分润时比例必须为 0")
        if (profit > 0 and total_amount < 0) or (profit < 0 and total_amount > 0):
            raise Validation("分润金额符号必须与订单利润一致")
        if profit == 0 or abs(total_amount) > abs(profit):
            raise Validation("分润金额合计不能超过订单总利润")

    # 整单重设：先清后写，避免残留旧比例
    for old in session.scalars(
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order.id)
    ).all():
        session.delete(old)
    session.flush()

    created = []
    for item in normalized_items:
        allocation_type = str(item["allocation_type"]).upper() if item.get("allocation_type") else None
        row = OrderProfitAllocation(
            order_id=order.id,
            # 收益人已在上面归一化：单一执行人自动填、多人由人工指定。
            user_id=int(item["user_id"]) if item.get("user_id") is not None else None,
            role=str(item["role"]).upper(),
            allocation_type=allocation_type,
            allocation_rate=to_money(item.get("allocation_rate") or 0),
            allocation_amount=to_money(item.get("allocation_amount") or 0),
        )
        session.add(row)
        created.append(row)
    session.flush()
    record_audit(
        session,
        action=AuditAction.PROFIT_ALLOCATION_SET,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        after={
            "allocations": [
                {"user_id": r.user_id, "role": r.role, "allocation_type": r.allocation_type, "rate": str(r.allocation_rate)}
                for r in created
            ]
        },
    )
    return collect_allocations(session, order)


__all__ = ["set_action_allocations"]
