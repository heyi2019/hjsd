"""订单分润配置服务（BAS-06-03）。"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any
from pydantic import ValidationError as PydanticValidationError
from app.core.audit import record_audit
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.users import User
from app.policy.profit_allocation.schemas import ProfitAllocationItem
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import Validation
from app.domain.enums import (
    AllocationRole,
    AuditAction,
)
from app.domain.trade import (
    Installment,
    Order,
    OrderEvent,
    OrderProfitAllocation,
)

from .._shared import (
    _scoped_order,
)

def _normalize_allocation_item(value: Any) -> dict[str, Any]:
    try:
        return ProfitAllocationItem.model_validate(value).model_dump()
    except PydanticValidationError as exc:
        errors = exc.errors()
        has_rate_error = any(
            error.get("loc") and error["loc"][-1] in {"allocation_rate", "allocation_amount"}
            for error in errors
        )
        raise Validation(
            "分配比例/金额必须是数值" if has_rate_error else "利润分配字段校验失败",
            details={"field": "items", "errors": errors},
        ) from exc


def set_allocations(
    session: Session,
    order_id: int,
    *,
    items: list[dict[str, Any]],
    actor: str = "system",
    form_extra: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    """整单重设分润。

    两种录入口径，整单只能选其一：

    - **按动作**（items 都带 allocation_type）：沿用 BAS-06-03 的四项结构
      （买号/售出/运营/公司归属），比例合计必须 100%，收益人绑定动作执行人。
    - **按人**（items 都不带 allocation_type）：每行一个姓名（user_id；为空表示
      公司归属），比例与金额都选填——填比例按利润占比分、填金额按固定额分。
      纯比例时合计仍须 100%；一旦出现金额，改为校验金额合计不超过订单利润，
      因为此时「剩余未分配」默认留在公司，强行凑 100% 会逼用户编数字。
    """
    # 按动作分配时，负责人来源和分润配置必须一次提交、一次生效。
    # 先合并订单来源字段，后续动作负责人校验才能使用本次刚编辑的人员名单。
    if form_extra:
        order = _scoped_order(session, order_id, user)
        order.form_extra = {**(order.form_extra or {}), **dict(form_extra)}
        session.flush()

    normalized_items = [_normalize_allocation_item(item) for item in items]
    typed = [item for item in normalized_items if item.get("allocation_type")]
    if typed and len(typed) != len(normalized_items):
        raise Validation("按动作分润与按人分润不能混用，请统一为其中一种")
    if typed:
        result = _set_action_allocations(
            session, order_id, items=items, actor=actor, user=user
        )
    else:
        result = _set_person_allocations(
            session, order_id, items=normalized_items, actor=actor, user=user
        )
    # 分润配置保存完成且订单已闭环 → 通知利润接收人（幂等，重复保存不重复打扰）。
    # 订单尚未完成时先只落分润，待 SELL 闭环由 notify_on_sell_completed 补发通知。
    from app.notifications.triggers import notify_profit_recipients

    notify_profit_recipients(session, _scoped_order(session, order_id, user), actor=actor)
    return result


def _set_person_allocations(
    session: Session,
    order_id: int,
    *,
    items: list[dict[str, Any]],
    actor: str,
    user: CurrentUser | None,
) -> list[dict[str, Any]]:
    """按人分润：姓名 + 比例或金额（二者都选填，同一行不可同时填）。"""
    from app.orders.amounts import order_amounts

    order = _scoped_order(session, order_id, user)
    if not items:
        raise Validation("分润不能为空", details={"field": "items"})

    total_rate = Decimal("0")
    total_amount = Decimal("0")
    user_ids: set[int] = set()
    person_roles: set[tuple[int, str]] = set()
    company_rows = 0
    for item in items:
        rate = to_money(item.get("allocation_rate") or 0)
        amount = to_money(item.get("allocation_amount") or 0)
        role = str(item.get("role") or "OWNER").upper()
        if role not in AllocationRole.values():
            raise Validation(
                f"分配角色必须为 {AllocationRole.values()}",
                details={"field": "role", "value": item.get("role")},
            )
        if rate != 0 and amount != 0:
            raise Validation(
                "同一分润行不能同时填比例和金额，二者只能选一个",
                details={"field": "items"},
            )
        user_id = item.get("user_id")
        if user_id is None:
            company_rows += 1
            if company_rows > 1:
                raise Validation("公司归属只能有一行", details={"field": "items"})
        else:
            # 去重键与 DB 唯一约束 uq_order_profit_alloc(order_id, allocation_type, user_id, role) 对齐：
            # 同一人可担任多个角色（如既做销售又做服务），但不能在同一角色下拿两份。
            if (int(user_id), role) in person_roles:
                raise Validation(
                    "同一人员在同一角色下不可重复分润",
                    details={"field": "items.user_id", "role": role},
                )
            person_roles.add((int(user_id), role))
            user_ids.add(int(user_id))
        total_rate += rate
        total_amount += amount

    existing_user_ids = {
        user_id
        for user_id in session.scalars(select(User.id).where(User.id.in_(user_ids))).all()
    }
    missing_user_ids = sorted(user_ids - existing_user_ids)
    if missing_user_ids:
        raise Validation(
            "分润人员不存在",
            details={"field": "items.user_id", "missing": missing_user_ids},
        )

    if total_amount != 0:
        profit = order_amounts(session, order_id)["PROFIT"]
        # 金额方向必须与订单盈亏一致：盈利单填正数、亏损单填负数（负数=该人分担的亏损额）。
        # 方向反了等于把亏损记成收益，故直接拒绝而不是取绝对值。
        if profit > 0 and total_amount < 0:
            raise Validation(
                f"该单为盈利单（利润 {profit}），分润金额不能为负数",
                details={"total_amount": str(total_amount), "profit": str(profit)},
            )
        if profit < 0 and total_amount > 0:
            raise Validation(
                f"该单为亏损单（利润 {profit}），分润金额必须填负数（亏损分担额）",
                details={"total_amount": str(total_amount), "profit": str(profit)},
            )
        if profit == 0:
            raise Validation(
                "该单利润为 0，按金额分润只能填 0；请改用比例分润",
                details={"total_amount": str(total_amount)},
            )
        # 以绝对值为界：亏损单的「不超过利润」= 不得超额分担亏损（profit=-1000 时下限 -1000）。
        if abs(total_amount) > abs(profit):
            raise Validation(
                f"分润金额合计 {total_amount} 超过订单利润 {profit}",
                details={"total_amount": str(total_amount), "profit": str(profit)},
            )
        if total_rate > Decimal("100"):
            raise Validation(
                "存在按金额分润时，比例合计不能超过 100%",
                details={"total_rate": str(total_rate)},
            )
    elif total_rate != Decimal("100.00"):
        raise Validation(
            "有效分配比例合计必须为 100%",
            details={"total": str(total_rate), "items": len(items)},
        )

    for old in session.scalars(
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order_id)
    ).all():
        session.delete(old)
    session.flush()

    created = []
    for item in items:
        row = OrderProfitAllocation(
            order_id=order_id,
            user_id=int(item["user_id"]) if item.get("user_id") is not None else None,
            role=str(item.get("role") or "OWNER").upper(),
            allocation_type=None,
            allocation_rate=to_money(item.get("allocation_rate") or 0),
            allocation_amount=to_money(item.get("allocation_amount") or 0),
            policy_version_id=order.policy_version_id,
        )
        session.add(row)
        created.append(row)
    session.flush()
    record_audit(
        session,
        action=AuditAction.PROFIT_ALLOCATION_SET,
        entity_type="order",
        entity_id=order_id,
        actor=actor,
        after={
            "allocations": [
                {
                    "user_id": r.user_id,
                    "role": r.role,
                    "allocation_type": r.allocation_type,
                    "rate": str(r.allocation_rate),
                    "amount": str(r.allocation_amount),
                }
                for r in created
            ]
        },
    )
    return list_allocations(session, order_id, user=user)


def _set_action_allocations(
    session: Session,
    order_id: int,
    *,
    items: list[dict[str, Any]],
    actor: str = "system",
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    """整单重设利润分配。**有效比例合计必须为 100%**（BAS-06-03）。"""
    order = _scoped_order(session, order_id, user)
    if not items:
        raise Validation("利润分配不能为空", details={"field": "items"})

    normalized_items = [_normalize_allocation_item(item) for item in items]
    total = Decimal("0")
    user_ids: set[int] = set()
    allocation_types: set[str] = set()
    # 四类必须齐全，但每个动作可以有多行（一个动作多人时按人数分别录一行，份额均分）。
    if any(not item.get("allocation_type") for item in normalized_items):
        raise Validation("利润分配项必须标注买号、售出、运营或公司归属")
    # 类型合法性先判：否则一个 BAD 会先被「四类不齐全」吞掉，用户看到的不是真实原因。
    for item in normalized_items:
        candidate = str(item["allocation_type"]).upper()
        if candidate not in {"BUY", "SELL", "OPERATION", "COMPANY"}:
            raise Validation(
                "分配项必须为 BUY、SELL、OPERATION 或 COMPANY；COMPANY 表示公司归属",
                details={"field": "allocation_type", "value": item["allocation_type"]},
            )
    present_types = {str(item["allocation_type"]).upper() for item in normalized_items}
    if present_types != {"BUY", "SELL", "OPERATION", "COMPANY"}:
        raise Validation("利润分配必须包含买号、售出、运营和公司归属四项")
    has_typed_items = True
    # 动作执行人候选：建单/卖出表单中的业务负责人是业务事实来源；
    # 没有表单负责人时，再回退到事件 operator_user_ids / created_by。
    action_actor_ids: dict[str, list[int]] = {}
    action_person_keys: set[tuple[str, int | None]] = set()
    if has_typed_items:
        for action_type in ("BUY", "SELL"):
            configured_key = {
                "BUY": "business_responsible_ids",
                "SELL": "delivery_responsible_ids",
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
                        f"{action_type} 动作负责人不存在或已停用，无法绑定收益人",
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
            if action is None and action_type == "BUY" and order.account_id is not None:
                action = session.scalar(select(OrderEvent).join(Order, Order.id == OrderEvent.order_id).where(Order.account_id == order.account_id, OrderEvent.event_type == "BUY", OrderEvent.is_posted.is_(True)).order_by(OrderEvent.id.desc()))
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
                    actor_id = session.scalar(
                        select(User.id).where(User.username == action.created_by)
                    )
                    if actor_id is None:
                        raise Validation(
                            f"{action_type} 动作执行人不存在，无法绑定收益人",
                            details={"event_id": action.id, "actor": action.created_by},
                        )
                    candidates = [int(actor_id)]
                action_actor_ids[action_type] = candidates
            elif action_type == "SELL":
                contract = session.scalar(select(Installment).where(Installment.order_id == order.id, Installment.contract_type == "STOCK_SALE"))
                if contract is not None:
                    actor_id = session.scalar(select(User.id).where(User.username == contract.created_by))
                    if actor_id is None:
                        raise Validation("售出动作执行人不存在，无法绑定收益人")
                    action_actor_ids[action_type] = [int(actor_id)]
            elif action_type == "BUY" and order.order_type in {"HS", "TH", "DG"}:
                # 回收、提号、代挂都属于买号业务动作；DG 沿用标准 SELL
                # 资金事件，因此其买号收益人取建单操作人员。
                creator_id = session.scalar(select(User.id).where(User.username == order.created_by))
                if creator_id is not None:
                    action_actor_ids[action_type] = [int(creator_id)]
    for item in normalized_items:
        rate = to_money(item.get("allocation_rate"))
        role = str(item.get("role") or "").upper()
        if role not in AllocationRole.values():
            raise Validation(
                f"分配角色必须为 {AllocationRole.values()}",
                details={"field": "role", "value": item.get("role")},
            )
        allocation_type = item.get("allocation_type")
        if allocation_type is not None:
            allocation_type = str(allocation_type).upper()
            if allocation_type not in {"BUY", "SELL", "OPERATION", "COMPANY"}:
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

    if total != Decimal("100.00"):
        raise Validation(
            "有效分配比例合计必须为 100%",
            details={"total": str(total), "items": len(items)},
        )

    # 整单重设：先清后写，避免残留旧比例
    for old in session.scalars(
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order_id)
    ).all():
        session.delete(old)
    session.flush()

    created = []
    for item in normalized_items:
        allocation_type = str(item["allocation_type"]).upper() if item.get("allocation_type") else None
        row = OrderProfitAllocation(
            order_id=order_id,
            # 收益人已在上面归一化：单一执行人自动填、多人由人工指定。
            user_id=int(item["user_id"]) if item.get("user_id") is not None else None,
            role=str(item["role"]).upper(),
            allocation_type=allocation_type,
            allocation_rate=to_money(item.get("allocation_rate")),
            allocation_amount=to_money(item.get("allocation_amount") or 0),
            policy_version_id=order.policy_version_id,
        )
        session.add(row)
        created.append(row)
    session.flush()
    record_audit(
        session,
        action=AuditAction.PROFIT_ALLOCATION_SET,
        entity_type="order",
        entity_id=order_id,
        actor=actor,
        after={
            "allocations": [
                {"user_id": r.user_id, "role": r.role, "allocation_type": r.allocation_type, "rate": str(r.allocation_rate)}
                for r in created
            ]
        },
    )
    return list_allocations(session, order_id, user=user)


def list_allocations(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> list[dict[str, Any]]:
    _scoped_order(session, order_id, user)
    rows = session.scalars(
        select(OrderProfitAllocation)
        .where(OrderProfitAllocation.order_id == order_id)
        .order_by(OrderProfitAllocation.id)
    ).all()
    total = Decimal("0")
    total_amount = Decimal("0")
    out = []
    for row in rows:
        total += to_money(row.allocation_rate)
        total_amount += to_money(row.allocation_amount)
        out.append(
            {
                "id": row.id,
                "order_id": row.order_id,
                "user_id": row.user_id,
                "role": row.role,
                "allocation_type": row.allocation_type,
                "allocation_rate": str(to_money(row.allocation_rate)),
                "allocation_amount": str(to_money(row.allocation_amount)),
                "policy_version_id": row.policy_version_id,
            }
        )
    return [
        {**item, "total_rate": str(total), "total_amount": str(total_amount)}
        for item in out
    ]

