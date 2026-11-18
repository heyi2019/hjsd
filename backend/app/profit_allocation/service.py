"""订单分润配置服务（BAS-06-03）——编排入口。

2026-11-18 从 718 行单文件按职责拆分：
- 公司比例与口径换算：terms.py
- 按动作表单行展开：action_rows.py
- 按人分润写路径：person.py
- 按动作分润写路径：action.py
- 查询与按动作汇总：listing.py
本文件只保留整单保存的编排与两种录入口径的分流。
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import OrderStatus
from app.profit_allocation.schemas import ProfitAllocationItem

from ._shared import _scoped_order
from .action import set_action_allocations
from .action_rows import expand_action_form_rows
from .person import set_person_allocations
from .terms import company_rate_for_order, order_profit_of


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
    order = _scoped_order(session, order_id, user)
    if order.status != OrderStatus.COMPLETED.value:
        raise Validation("订单售出完成后才能配置分润", details={"order_id": order_id})

    original_form_extra = order.form_extra
    if form_extra:
        order.form_extra = {**(order.form_extra or {}), **dict(form_extra)}
    try:
        normalized_items = [_normalize_allocation_item(item) for item in items]
        typed = [item for item in normalized_items if item.get("allocation_type")]
        if typed and len(typed) != len(normalized_items):
            raise Validation("按动作分润与按人分润不能混用，请统一为其中一种")
        if typed:
            if any(item.get("employee_ids") for item in typed):
                order_profit = order_profit_of(session, order)
                normalized_items = expand_action_form_rows(
                    typed,
                    order_profit=order_profit,
                    company_rate=company_rate_for_order(order, order_profit),
                )
            result = set_action_allocations(
                session, order, items=normalized_items, actor=actor
            )
        else:
            result = set_person_allocations(
                session, order, items=normalized_items, actor=actor
            )
    except Exception:
        if form_extra:
            order.form_extra = original_form_extra
        raise
    # 分润配置保存完成 → 通知利润接收人（幂等，重复保存不重复打扰）。
    from app.notifications.triggers import notify_profit_recipients

    notify_profit_recipients(session, order, actor=actor)
    return result


__all__ = ["set_allocations"]
