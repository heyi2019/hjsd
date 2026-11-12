"""orders.output_labels：订单/事件输出的纯标签计算（在手时长、操作人、表单责任人）。

只依赖标准库与类型注解，不碰 Session / 权限 / 事务；由 router_output 具名导入使用。
"""
from __future__ import annotations

from datetime import datetime

from app.domain.trade import OrderEvent


def _elapsed_label(start: datetime | None, end: datetime | None) -> str:
    """入库到售出的在手时长，按「X天X小时X分」展示（与前端 formatElapsedTime 同口径）。

    缺任一端或时间倒挂返回 "-"：未售账号的「已持有多久」属库存中心「未售时长」，
    台账只表达「实际在手过多久」，不按当前时刻推算。
    """
    if start is None or end is None or end < start:
        return "-"
    try:
        total_minutes = int((end - start).total_seconds()) // 60
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
    event: OrderEvent | None, operator_names: dict[int, str] | None
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
