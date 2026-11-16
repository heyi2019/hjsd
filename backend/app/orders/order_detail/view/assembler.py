"""订单详情响应装配。

查询路由只负责取数；订单响应和详情派生模型在本目录内统一装配，避免不同入口
各自拼一套详情结构。
"""
from __future__ import annotations

from typing import Any

from .execution_schemas import AccountExecutionOrderOut


def build_order_outputs(
    orders: list[Any],
    *,
    order_extra_values: dict[int, dict[str, object]],
    field_defs_by_type: dict[str, dict[str, Any]],
    cashflows_by_order: dict[int, list[Any]],
    customers_by_order: dict[int, list[Any]],
    counterparties_by_order: dict[int, list[Any]],
    rebates_by_order: dict[int, list[Any]],
    events_by_order: dict[int, list[Any]],
    operator_names_by_order: dict[int, list[str]] | None = None,
) -> list[AccountExecutionOrderOut]:
    outputs: list[AccountExecutionOrderOut] = []
    for order in orders:
        definitions = field_defs_by_type.get(order.order_type, {})
        extra_values = order_extra_values.get(order.id, {})
        extra_fields = [
            {
                "key": key,
                "label": definitions.get(key).label if definitions.get(key) else key,
                "section": definitions.get(key).section if definitions.get(key) else "EXTRA",
                "value": value,
            }
            for key, value in extra_values.items()
            if value not in (None, "", [])
        ]
        outputs.append(
            AccountExecutionOrderOut(
                order_id=order.id,
                order_no=order.order_no,
                order_type=order.order_type,
                trade_date=order.trade_date,
                created_at=order.created_at,
                status=order.status,
                account_platform=(order.account_snapshot or {}).get("platform"),
                note=order.note,
                extra_values=extra_values,
                extra_fields=extra_fields,
                cashflows=cashflows_by_order.get(order.id, []),
                customers=customers_by_order.get(order.id, []),
                counterparties=counterparties_by_order.get(order.id, []),
                rebates=rebates_by_order.get(order.id, []),
                events=events_by_order.get(order.id, []),
                operator="、".join((operator_names_by_order or {}).get(order.id, [])) or order.created_by,
                operator_user_ids=(
                    list(extra_values["business_responsible_ids"])
                    if isinstance(extra_values.get("business_responsible_ids"), list)
                    else None
                ),
            )
        )
    return outputs
