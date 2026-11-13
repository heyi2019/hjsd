"""订单详情页的业务派生计算。

输入是已经按权限和订单范围装配好的响应对象；这里不访问数据库，保证详情页
所有列表与汇总使用同一份后端口径。
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from app.core.money import to_money

from .schemas import (
    DetailExecutionRowOut,
    DetailExtraOut,
    DetailFinanceRowOut,
    DetailLifecycleOut,
    DetailOperationRowOut,
    DetailPartyOut,
    OrderDetailViewOut,
)

if TYPE_CHECKING:
    from ..schemas import AccountExecutionOrderOut

INVENTORY_ORDER_TYPES = frozenset({"HS", "TH", "DG"})
INTERNAL_EXTRA_KEYS = frozenset({
    "consignment_platform",
    "listed_at",
    "platform_unlisted_at",
    "platform_unlist_scope",
})

ENTRY_ACTION = {"HS": "回收入库", "TH": "提号入库", "DG": "代挂入库"}
EVENT_ACTION = {
    "DELIVER": "买号交付",
    "SELL": "账号售出",
    "CANCEL": "取消",
    "OPERATE": "运营",
    "REBATE": "返点",
}
def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _operator(event: Any) -> str:
    names = getattr(event, "operator_names", None) or []
    return "、".join(names) or getattr(event, "operator", None) or "-"


def _event_action(event: Any, order_type: str) -> str:
    if event.event_type == "BUY":
        return ENTRY_ACTION.get(order_type, "账号入库")
    if event.event_type == "DELIVER":
        return "买号交付" if event.delivery_direction == "BUY" else "卖号交付"
    return EVENT_ACTION.get(event.event_type, "运营")


def _platform_values(order: AccountExecutionOrderOut) -> list[str]:
    values = [order.account_platform]
    values.extend(
        party.display_name
        for party in order.counterparties
        if party.role == "PLATFORM"
    )
    return [item.strip() for item in values if isinstance(item, str) and item.strip()]


def _consignment_platform(order: AccountExecutionOrderOut) -> str:
    for event in order.events:
        if event.event_type == "OPERATE" and event.operation_type == "CONSIGNMENT":
            platform = _text(event.form_extra.get("consignment_platform"))
            if platform:
                return platform
    return "-"


def _event_platform(order: AccountExecutionOrderOut, event: Any, has_system_unlisted: bool) -> str:
    if event.event_type == "OPERATE":
        platform = _text(event.form_extra.get("consignment_platform"))
        return platform or order.account_platform or "-"
    if event.event_type != "CANCEL":
        return order.account_platform or "-"
    scope = order.extra_values.get("platform_unlist_scope")
    if scope == "SYSTEM" or (scope is None and has_system_unlisted):
        return "本系统"
    return _consignment_platform(order)


def _operation_timestamp(event: Any) -> datetime | None:
    if event is None:
        return None
    extra = event.form_extra
    explicit = extra.get("listed_at") if event.operation_type == "CONSIGNMENT" else extra.get("platform_unlisted_at") if event.operation_type == "UNLIST" else None
    if isinstance(explicit, datetime):
        return explicit
    if explicit:
        try:
            return datetime.fromisoformat(str(explicit).replace("Z", "+00:00"))
        except ValueError:
            pass
    return event.occurred_at


def _latest_operation(orders: Iterable[AccountExecutionOrderOut], operation_type: str) -> Any | None:
    events = [
        event
        for order in orders
        for event in order.events
        if event.event_type == "OPERATE" and event.operation_type == operation_type
    ]
    return max(events, key=lambda event: _operation_timestamp(event) or datetime.min, default=None)


def _operation_rows(orders: list[AccountExecutionOrderOut]) -> list[DetailOperationRowOut]:
    consignment = _latest_operation(orders, "CONSIGNMENT")
    unlist = _latest_operation(orders, "UNLIST")
    description = _latest_operation(orders, "DESCRIPTION")
    image = _latest_operation(orders, "IMAGE")
    consignment_platform = _text(consignment.form_extra.get("consignment_platform")) if consignment else ""
    price = consignment.form_extra.get("consignment_price") if consignment else None
    listed_content = consignment_platform
    if price not in (None, ""):
        listed_content = f"{listed_content} / 寄售价 ¥{to_money(price):,.2f}" if listed_content else f"寄售价 ¥{to_money(price):,.2f}"
    unlisted_content = "本系统" if unlist and unlist.form_extra.get("platform_unlist_scope") == "SYSTEM" else (_text(unlist.form_extra.get("consignment_platform")) if unlist else "")
    return [
        DetailOperationRowOut(key="consignment", action="上架平台", content=listed_content or "-", occurred_at=_operation_timestamp(consignment), operator=_operator(consignment) if consignment else "-"),
        DetailOperationRowOut(key="unlist", action="下架平台", content=unlisted_content or "-", occurred_at=_operation_timestamp(unlist), operator=_operator(unlist) if unlist else "-"),
        DetailOperationRowOut(key="description", action="描述", content="-", occurred_at=_operation_timestamp(description), operator=_operator(description) if description else "-"),
        DetailOperationRowOut(key="images", action="作图", content="-", occurred_at=_operation_timestamp(image), operator=_operator(image) if image else "-"),
    ]


def _execution_rows(orders: list[AccountExecutionOrderOut]) -> list[DetailExecutionRowOut]:
    has_system_unlisted = any(
        order.order_type == "DG" and order.extra_values.get("platform_unlist_scope") == "SYSTEM"
        for order in orders
    )
    rows: list[DetailExecutionRowOut] = []
    for order in orders:
        if order.order_type in INVENTORY_ORDER_TYPES and not any(event.event_type == "BUY" for event in order.events):
            rows.append(DetailExecutionRowOut(
                key=f"{order.order_id}-inventory-entry",
                category="INBOUND",
                action=ENTRY_ACTION.get(order.order_type, "账号入库"),
                occurred_at=order.created_at,
                amount=None,
                operator=order.operator or "-",
                note="-",
                platform=order.account_platform or "-",
            ))
        rows.extend(
            DetailExecutionRowOut(
                key=f"{order.order_id}-{event.id}",
                category="INBOUND" if event.event_type == "BUY" else "OUTBOUND" if event.event_type == "SELL" else "OPERATING",
                action=_event_action(event, order.order_type),
                occurred_at=event.occurred_at,
                amount=event.amount,
                operator=_operator(event),
                note=event.note or "-",
                platform=_event_platform(order, event, has_system_unlisted),
                event_id=event.id,
            )
            for event in order.events
        )
    return rows


def _finance_type(event_type: str, direction: str, category: str | None = None) -> str:
    labels = {
        "BUY": "买号支出", "SELL": "售出收入", "INSTALLMENT_PAYMENT": "分期回款",
        "REBATE": "返点收入", "REFUND": "退款支出", "CANCEL": "取消冲销",
        "OPERATING_EXPENSE": "运营费用", "ADDITIONAL_INCOME": "附加收入", "ADDITIONAL_EXPENSE": "附加支出",
    }
    return labels.get(event_type) or labels.get(category or "") or ("其他收入" if direction == "IN" else "其他支出")


def _rebate_type(rebate: Any) -> str:
    if rebate.rebate_type == "BUY": return "买号返点"
    if rebate.rebate_type == "SELL": return "卖号返点"
    if rebate.channel in {"买号返点", "卖号返点"}: return rebate.channel
    return "其他返点"


def _finance_rows(orders: list[AccountExecutionOrderOut]) -> list[DetailFinanceRowOut]:
    rows: list[DetailFinanceRowOut] = []
    for order in orders:
        for event in order.events:
            if event.cashflow:
                flow = event.cashflow
                rows.append(DetailFinanceRowOut(
                    key=f"flow-{flow.flow_no}", type=_finance_type(event.event_type, flow.direction, flow.category),
                    direction="支出" if flow.direction == "OUT" else "收入", amount=flow.amount,
                    occurred_at=flow.occurred_at, pool_name=flow.pool_name or "未分配资金池",
                    operator=flow.operator or _operator(event), event_id=event.id,
                ))
        for flow in order.cashflows:
            rows.append(DetailFinanceRowOut(
                key=f"flow-{flow.flow_no}", type=_finance_type("", flow.direction, flow.category),
                direction="支出" if flow.direction == "OUT" else "收入", amount=flow.amount,
                occurred_at=flow.occurred_at, pool_name=flow.pool_name or "未分配资金池", operator=flow.operator or "-",
            ))
        for rebate in order.rebates:
            rows.append(DetailFinanceRowOut(
                key=f"rebate-{rebate.id}", type=_rebate_type(rebate), direction="收入", amount=rebate.base_amount,
                occurred_at=rebate.collected_at, pool_name="-", operator="-",
            ))
    return rows


def _parties(orders: list[AccountExecutionOrderOut]) -> list[DetailPartyOut]:
    result: list[DetailPartyOut] = []
    seen: set[str] = set()
    for order in orders:
        parties = [
            *((item, "customer") for item in order.customers),
            *((item, "counterparty") for item in order.counterparties),
        ]
        for party, entity_type in parties:
            key = f"{entity_type}:{party.id}:{party.role}"
            if key in seen: continue
            seen.add(key)
            result.append(DetailPartyOut(id=party.id, display_name=party.display_name, role=party.role, entity_type=entity_type))
    return result


def _extras(orders: list[AccountExecutionOrderOut]) -> list[DetailExtraOut]:
    result: list[DetailExtraOut] = []
    for order in orders:
        fields = order.extra_fields or [
            {"key": key, "label": key, "value": value, "section": "EXTRA"}
            for key, value in order.extra_values.items()
        ]
        for field in fields:
            key = str(field.get("key", ""))
            if any(key == item or key.endswith(f"-{item}") for item in INTERNAL_EXTRA_KEYS): continue
            value = field.get("value")
            if value in (None, "") or not str(value).strip(): continue
            result.append(DetailExtraOut(key=f"{order.order_no}-{key}", label=str(field.get("label", key)), value=str(value), section=str(field.get("section", "EXTRA"))))
    return result


def build_detail_view(orders: list[AccountExecutionOrderOut]) -> OrderDetailViewOut:
    sell = next(((event, order) for order in orders for event in order.events if event.event_type == "SELL"), None)
    cancel = next(((event, order) for order in orders for event in order.events if event.event_type == "CANCEL"), None)
    recovery = sorted({platform for order in orders if order.order_type in {"HS", "TH"} for platform in _platform_values(order)})
    sale = sorted({platform for order in orders if order.order_type == "DG" or any(event.event_type == "SELL" for event in order.events) for platform in _platform_values(order)})
    notes = next((order.note.strip() for order in orders if order.order_type != "DG" and order.note and order.note.strip()), "-")
    return OrderDetailViewOut(
        execution_rows=_execution_rows(orders),
        finance_rows=_finance_rows(orders),
        operation_rows=_operation_rows(orders),
        lifecycle=DetailLifecycleOut(
            sold_at=sell[0].occurred_at if sell else None,
            removed_at=cancel[0].occurred_at if cancel else None,
            removed_platform=_event_platform(cancel[1], cancel[0], any(order.extra_values.get("platform_unlist_scope") == "SYSTEM" for order in orders)) if cancel else "-",
            recovery_platform="、".join(recovery) or "-",
            sale_platform="、".join(sale) or "-",
        ),
        order_notes=notes,
        parties=_parties(orders),
        extras=_extras(orders),
    )
