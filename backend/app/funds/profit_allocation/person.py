"""按人分润写路径：姓名（user_id，空=公司归属）+ 比例或金额。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import AllocationRole, AuditAction
from app.domain.trade import Order, OrderProfitAllocation
from app.domain.users import User

from .listing import collect_allocations
from .terms import validate_amount_directions


def set_person_allocations(
    session: Session,
    order: Order,
    *,
    items: list[dict[str, Any]],
    actor: str,
) -> list[dict[str, Any]]:
    """按人分润：姓名 + 比例或金额（二者都选填，同一行不可同时填）。"""
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

    amounts = [to_money(item.get("allocation_amount") or 0) for item in items]
    if any(amount != 0 for amount in amounts):
        from app.shared.order_amounts import order_amounts

        profit = order_amounts(session, order.id)["PROFIT"]
        validate_amount_directions(amounts, profit)
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
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order.id)
    ).all():
        session.delete(old)
    session.flush()

    created = []
    for item in items:
        row = OrderProfitAllocation(
            order_id=order.id,
            user_id=int(item["user_id"]) if item.get("user_id") is not None else None,
            role=str(item.get("role") or "OWNER").upper(),
            allocation_type=None,
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
    return collect_allocations(session, order)


__all__ = ["set_person_allocations"]
