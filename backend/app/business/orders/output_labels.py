"""orders.output_labels：订单/事件输出的纯标签计算（在手时长、操作人、表单责任人）。

只依赖标准库与类型注解，不碰 Session / 权限 / 事务；由 router_output 具名导入使用。
"""
from __future__ import annotations

from datetime import datetime

from app.domain.trade import Cashflow, OrderEvent


def _elapsed_label(
    start: datetime | None,
    end: datetime | None,
    *,
    now: datetime | None = None,
) -> str:
    """统一计算入库到当前/售出的持有时长，按「X天X小时X分」展示。

    未售时以当前时间作为结束点，已售时以售出时间作为结束点；两个列表只展示这一个
    后端口径，前端不再自行补算或把未售账号显示成空值。
    """
    if start is None:
        return "-"
    effective_end = end if end is not None else (now or datetime.now())
    # 售卖事件只有业务日期时会落在当天 00:00；与入库时刻比较会倒挂，
    # 按库存库龄的“未来时间归零”口径展示为 0 分，而不是丢失时长。
    if effective_end < start:
        effective_end = start
    try:
        total_minutes = int((effective_end - start).total_seconds()) // 60
    except TypeError:  # 一端带时区一端不带（历史导入数据）时不做臆测
        return "-"
    days, rest = divmod(total_minutes, 1_440)
    hours, minutes = divmod(rest, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days}天")
    if hours:
        parts.append(f"{hours}小时")
    if minutes or not parts:
        parts.append(f"{minutes}分")
    return "".join(parts)


def _selected_operator_label(
    event: OrderEvent | Cashflow | None, operator_names: dict[int, str] | None
) -> str:
    if event is None:
        return ""
    return "、".join(
        operator_names[user_id]
        for user_id in (event.operator_user_ids or [])
        if operator_names and user_id in operator_names
    )


def _form_responsible_label(
    form_extra: dict | None,
    user_names: dict[int, str],
    fallback: str | None,
) -> str | None:
    values = (form_extra or {}).get("business_responsible_ids")
    if not isinstance(values, list):
        return fallback
    labels = [user_names[item] for item in values if isinstance(item, int) and item in user_names]
    return "、".join(labels) if labels else fallback
