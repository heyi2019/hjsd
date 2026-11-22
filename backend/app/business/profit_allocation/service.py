"""利润分配主体服务（BAS-06-03）——分润域唯一编排入口与总调度。

本模块是外部调用本域的**唯一主体服务**，对外提供三个主编排入口：

- set_allocations()    写路径：整单保存、售出守卫、两种录入口径分流、
                       form_extra 回滚与利润接收人通知
- get_allocations_view() 读路径：明细 + 口径 + 按动作汇总的响应组装
- convert_value()      比例↔金额换算

其余模块为被本服务调动的职责单元，不对外暴露入口：

- terms.py       公司比例与口径换算（含比例↔金额 convert）
- action_rows.py 按动作表单行展开与校验（纯函数）
- person.py      按人分润写路径
- action.py      按动作分润写路径
- listing.py     查询与按动作汇总（读路径）

"""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.shared.form_field_rules import validate_form_extra
from app.core.security import CurrentUser
from app.domain.enums import OrderStatus
from app.domain.notifications import Notification
from app.business.profit_allocation.schemas import ProfitAllocationItem

from app.shared.order_access import get_order
from .company_settings import get_company_settings
from .calculation import effective_distribution
from .candidates import allocation_candidates
from app.domain.trade import OrderProfitAllocation
from .action import set_action_allocations
from .action_rows import expand_action_form_rows
from .listing import collect_allocations
from .listing import allocation_form_rows, summarize_allocations_by_type
from .person import set_person_allocations
from .terms import (
    allocation_terms,
    company_rate_for_profit,
    convert_action_allocation,
    order_profit_of,
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
    """整单重设已售订单的分润。

    两种录入口径，整单只能选其一：

    - **按动作**（items 都带 allocation_type）：买号/售出/运营/公司四项，可按比例或金额；
      前端提交每项合计和人员，服务端校验并拆分到具体人员。
    - **按人**（items 都不带 allocation_type）：每行一个姓名（user_id；为空表示
      公司归属），比例与金额都选填——填比例按利润占比分、填金额按固定额分。
      纯比例时合计仍须 100%；一旦出现金额，改为校验金额合计不超过订单利润，
      因为此时「剩余未分配」默认留在公司，强行凑 100% 会逼用户编数字。
    """
    order = get_order(session, order_id, user)
    if order.status != OrderStatus.COMPLETED.value:
        raise Validation("订单售出完成后才能配置分润", details={"order_id": order_id})

    def snapshot(rows):
        return frozenset((row["user_id"], row["role"], row["allocation_type"], row["allocation_rate"], row["allocation_amount"]) for row in rows)

    previous_allocations = snapshot(collect_allocations(session, order))
    pending_id = session.scalar(select(func.max(Notification.id)).where(
        Notification.notification_type == "PROFIT_PENDING", Notification.entity_type == "order",
        Notification.entity_id == order.order_no,
    )) or 0
    allocated_id = session.scalar(select(func.max(Notification.id)).where(
        Notification.notification_type == "PROFIT_ALLOCATED", Notification.entity_type == "order",
        Notification.entity_id == order.order_no,
    )) or 0
    pending_sale = pending_id > allocated_id

    normalized_items = [_normalize_allocation_item(item) for item in items]
    typed = [item for item in normalized_items if item.get("allocation_type")]
    submitted_extra = dict(form_extra or {})
    if typed and any(item.get("employee_ids") for item in typed):
        # 责任人由本次分润选择派生，不信任客户端重复提交的人员字段。
        for kind, key in (("BUY", "business_responsible_ids"),
                          ("SELL", "sell_delivery_responsible_ids"),
                          ("OPERATION", "operation_responsible_ids")):
            submitted_extra[key] = list(dict.fromkeys(
                uid for item in typed if str(item.get("allocation_type")).upper() == kind
                for uid in item.get("employee_ids", [])
            ))
    checked_extra = validate_form_extra(session, order_type_code="ALLOCATION", values=submitted_extra)
    original_form_extra = order.form_extra
    if checked_extra:
        order.form_extra = {**(order.form_extra or {}), **checked_extra}
    try:
        if typed and len(typed) != len(normalized_items):
            raise Validation("按动作分润与按人分润不能混用，请统一为其中一种")
        if typed:
            if any(item.get("employee_ids") for item in typed):
                order_profit = order_profit_of(session, order)
                normalized_items = expand_action_form_rows(
                    typed,
                    order_profit=order_profit,
                    company_rate=company_rate_for_profit(order_profit, get_company_settings(session)),
                )
            result = set_action_allocations(
                session, order, items=normalized_items, actor=actor
            )
        else:
            result = set_person_allocations(
                session, order, items=normalized_items, actor=actor
            )
    except Exception:
        if checked_extra:
            order.form_extra = original_form_extra
        raise
    # 分润配置保存完成 → 通知利润接收人（幂等，重复保存不重复打扰）。
    from app.workbench.notifications.triggers import notify_profit_recipients

    notify_profit_recipients(session, order, actor=actor,
                             new_revision=pending_sale or previous_allocations != snapshot(result))
    return result


def get_allocations_view(
    session: Session,
    order_id: int,
    *,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """读路径主编排：分润明细 + 口径 + 按动作汇总，一次性组好响应数据。

    HTTP 层只负责把结果映射到响应契约；查询、口径与汇总的编排都在此主体服务。
    """
    order = get_order(session, order_id, user)
    terms = allocation_terms(session, order)
    stored = list(session.scalars(select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order.id).order_by(OrderProfitAllocation.id)).all())
    rows, amounts, rates = effective_distribution(stored, terms["order_profit"], terms["company_rate"])
    zero_profit = terms["order_profit"] == 0
    items = [{"id": row.id, "order_id": order.id, "user_id": row.user_id, "role": row.role,
              "allocation_type": row.allocation_type, "allocation_rate": str(rates[row.id] if zero_profit else 0),
              "allocation_amount": str(amounts[row.id]), "total_rate": "0", "total_amount": "0"} for row in rows]
    total_rate = sum((rates[row.id] for row in rows), 0) if zero_profit else 0
    total_amount = sum(amounts.values(), 0)
    for item in items:
        item.update(total_rate=str(total_rate), total_amount=str(total_amount))
    totals_by_type = summarize_allocations_by_type(items)
    if not zero_profit:
        for total in totals_by_type.values():
            total["allocation_rate"] = (total["allocation_amount"] * Decimal("100") / terms["order_profit"]).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP,
            )
    candidates = allocation_candidates(session, order, user)
    return {"items": items, "total": len(items), "totals_by_type": totals_by_type,
            "action_candidates": candidates,
            "form_rows": allocation_form_rows(items, candidates, totals_by_type, terms["company_rate"]), **terms}


def convert_value(
    session: Session,
    order_id: int,
    *,
    direction: str,
    value: Any,
    user: CurrentUser | None = None,
) -> Any:
    """换算主编排：比例↔金额换算统一从本主体服务进出。"""
    return convert_action_allocation(
        session, order_id, direction=direction, value=value, user=user
    )


__all__ = ["set_allocations", "get_allocations_view", "convert_value"]
