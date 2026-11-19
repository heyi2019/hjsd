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

2026-11-18 从 718 行单文件按职责拆分；包级 __init__ 不再重导出符号，
调用方直连本服务或上述真实模块。
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
from .listing import list_allocations as _list_allocations
from .listing import summarize_allocations_by_type
from .person import set_person_allocations
from .terms import (
    allocation_terms,
    company_rate_for_order,
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


def get_allocations_view(
    session: Session,
    order_id: int,
    *,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """读路径主编排：分润明细 + 口径 + 按动作汇总，一次性组好响应数据。

    HTTP 层只负责把结果映射到响应契约；查询、口径与汇总的编排都在此主体服务。
    """
    items = _list_allocations(session, order_id, user=user)
    return {
        "items": items,
        "total": len(items),
        "totals_by_type": summarize_allocations_by_type(items),
        **allocation_terms(session, order_id, user=user),
    }


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
