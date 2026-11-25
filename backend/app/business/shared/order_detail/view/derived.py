"""订单详情页的业务派生计算。

输入是已经按权限和订单范围装配好的响应对象；这里不访问数据库，保证详情页
所有列表与汇总使用同一份后端口径。
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from app.core.money import to_money
from app.business.shared.delivery_fields import SELL_DELIVERY_FIELDS

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
    from .execution_schemas import AccountExecutionOrderOut

INVENTORY_ORDER_TYPES = frozenset({"HS", "TH", "DG"})
INTERNAL_EXTRA_KEYS = frozenset({
    "consignment_platforms",
    "consignment_platform_labels",
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
def _platforms(value: Any) -> list[str]:
    return [item.strip() for item in value if isinstance(item, str) and item.strip()] if isinstance(value, list) else []


def _platform_text(extra: dict[str, Any]) -> str:
    labels = extra.get("consignment_platform_labels")
    labels = labels if isinstance(labels, dict) else {}
    return "、".join(labels.get(value, value) for value in _platforms(extra.get("consignment_platforms")))


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
    values: list[str] = []
    values.extend(
        party.display_name
        for party in order.counterparties
        if party.role == "PLATFORM"
    )
    return [item.strip() for item in values if isinstance(item, str) and item.strip()]


def _consignment_platform(order: AccountExecutionOrderOut) -> str:
    for event in order.events:
        if event.event_type == "OPERATE" and event.operation_type == "CONSIGNMENT":
            platform = _platform_text(event.form_extra)
            if platform:
                return platform
    return "-"


def _event_platform(order: AccountExecutionOrderOut, event: Any, has_system_unlisted: bool) -> str:
    if event.event_type == "OPERATE":
        platform = _platform_text(event.form_extra)
        return platform or "-"
    if event.event_type != "CANCEL":
        return "-"
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


def _operation_rows(
    orders: list[AccountExecutionOrderOut],
    *,
    account_description: str | None = None,
    account_images: list[str] | None = None,
) -> list[DetailOperationRowOut]:
    consignment = _latest_operation(orders, "CONSIGNMENT")
    unlist = _latest_operation(orders, "UNLIST")
    description = _latest_operation(orders, "DESCRIPTION")
    image = _latest_operation(orders, "IMAGE")
    consignment_platform = _platform_text(consignment.form_extra) if consignment else ""
    price = consignment.form_extra.get("consignment_price") if consignment else None
    listed_content = consignment_platform
    if price not in (None, ""):
        listed_content = f"{listed_content} / 寄售价 ¥{to_money(price):,.2f}" if listed_content else f"寄售价 ¥{to_money(price):,.2f}"
    unlisted_content = "本系统" if unlist and unlist.form_extra.get("platform_unlist_scope") == "SYSTEM" else (_platform_text(unlist.form_extra) if unlist else "")
    return [
        DetailOperationRowOut(key="consignment", action="上架平台", content=listed_content or "-", occurred_at=_operation_timestamp(consignment), operator=_operator(consignment) if consignment else "-", event_id=consignment.id if consignment else None),
        DetailOperationRowOut(key="unlist", action="下架平台", content=unlisted_content or "-", occurred_at=_operation_timestamp(unlist), operator=_operator(unlist) if unlist else "-", event_id=unlist.id if unlist else None),
        DetailOperationRowOut(key="description", action="描述", content=account_description or "-", occurred_at=_operation_timestamp(description), operator=_operator(description) if description else "-", event_id=description.id if description else None),
        DetailOperationRowOut(key="images", action="作图", content=f"已上传 {len(account_images or [])} 张" if account_images else "-", occurred_at=_operation_timestamp(image), operator=_operator(image) if image else "-", event_id=image.id if image else None),
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
                order_id=order.order_id,
                category="INBOUND",
                action=ENTRY_ACTION.get(order.order_type, "账号入库"),
                occurred_at=order.occurred_at or order.created_at,
                amount=None,
                operator=order.operator or "-",
                operator_user_ids=order.operator_user_ids,
                note="-",
                platform="-",
            ))
        rows.extend(
            DetailExecutionRowOut(
                key=f"{order.order_id}-{event.id}",
                order_id=order.order_id,
                category="INBOUND" if event.event_type == "BUY" else "OUTBOUND" if event.event_type == "SELL" else "OPERATING",
                action=_event_action(event, order.order_type),
                occurred_at=event.occurred_at,
                amount=event.amount,
                operator=(order.operator or "-") if event.event_type == "BUY" and order.order_type in INVENTORY_ORDER_TYPES else _operator(event),
                operator_user_ids=order.operator_user_ids if event.event_type == "BUY" and order.order_type in INVENTORY_ORDER_TYPES else event.operator_user_ids,
                note=event.note or "-",
                platform=_event_platform(order, event, has_system_unlisted),
                event_id=event.id,
            )
            for event in order.events
        )
    return rows


def _finance_type(
    event_type: str,
    direction: str,
    category: str | None = None,
    *,
    order_type: str | None = None,
) -> str:
    if event_type == "BUY":
        # DG 不允许 BUY（仅全款），无代挂成本概念，BUY 标签只区分回收/提号。
        return {"HS": "回收成本", "TH": "提号成本"}.get(order_type, "成本")
    labels = {
        "SELL": "售出收入", "INSTALLMENT_PAYMENT": "分期回款",
        "REBATE": "返点收入", "REFUND": "退款支出", "CANCEL": "取消冲销",
        "OPERATING_EXPENSE": "运营费用",
    }
    return labels.get(event_type) or labels.get(category or "") or ("其他收入" if direction == "IN" else "其他支出")


def _rebate_type(rebate: Any) -> str:
    if rebate.rebate_type == "BUY": return "买号返点"
    if rebate.rebate_type == "SELL": return "卖号返点"
    if rebate.channel in {"买号返点", "卖号返点"}: return rebate.channel
    return "其他返点"


def _finance_rows(
    orders: list[AccountExecutionOrderOut],
    *,
    action_model_rebate_nos: set[str] | None = None,
) -> list[DetailFinanceRowOut]:
    action_model_rebate_nos = action_model_rebate_nos or set()
    rows: list[DetailFinanceRowOut] = []
    for order in orders:
        for event in order.events:
            for flow in event.cashflows or ([event.cashflow] if event.cashflow else []):
                rows.append(DetailFinanceRowOut(
                    key=f"flow-{flow.flow_no}", flow_no=flow.flow_no, type=_finance_type(event.event_type, flow.direction, flow.category, order_type=order.order_type),
                    direction="支出" if flow.direction == "OUT" else "收入", amount=flow.amount,
                    occurred_at=flow.occurred_at, pool_id=flow.pool_id, pool_name=flow.pool_name or "未分配资金账户", note=flow.note or "",
                    operator=flow.operator or _operator(event), operator_user_ids=flow.operator_user_ids, event_id=event.id,
                ))
        for flow in order.cashflows:
            rows.append(DetailFinanceRowOut(
                key=f"flow-{flow.flow_no}", flow_no=flow.flow_no, type=_finance_type("", flow.direction, flow.category, order_type=order.order_type),
                direction="支出" if flow.direction == "OUT" else "收入", amount=flow.amount,
                occurred_at=flow.occurred_at, pool_id=flow.pool_id, pool_name=flow.pool_name or "未分配资金账户", note=flow.note or "", operator=flow.operator or "-",
                operator_user_ids=flow.operator_user_ids,
            ))
        for rebate in order.rebates:
            if rebate.rebate_no in action_model_rebate_nos:
                continue
            rows.append(DetailFinanceRowOut(
                key=f"rebate-{rebate.id}", flow_no=rebate.rebate_no, type=_rebate_type(rebate),
                direction="收入", amount=rebate.amount, occurred_at=rebate.collected_at,
                pool_name="-", note="", operator="-",
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
            if key in SELL_DELIVERY_FIELDS or any(key == item or key.endswith(f"-{item}") for item in INTERNAL_EXTRA_KEYS): continue
            value = field.get("value")
            if value in (None, "") or not str(value).strip(): continue
            label = (order.option_label_snapshot or {}).get(key)
            if isinstance(value, str) and isinstance(label, str):
                value = label
            else:
                labels = field.get("value_labels") if isinstance(field.get("value_labels"), dict) else {}
                if isinstance(label, dict):
                    labels = {**labels, **label}
                if isinstance(value, str):
                    value = labels.get(value, value)
                elif isinstance(value, list) and labels:
                    value = "、".join(labels.get(item, item) if isinstance(item, str) else str(item) for item in value)
            result.append(DetailExtraOut(key=f"{order.order_no}-{key}", label=str(field.get("label", key)), value=str(value), section=str(field.get("section", "EXTRA"))))
    return result


def build_detail_view(
    orders: list[AccountExecutionOrderOut],
    *,
    account_description: str | None = None,
    account_images: list[str] | None = None,
    action_model_rebate_nos: set[str] | None = None,
) -> OrderDetailViewOut:
    sell = next(((event, order) for order in orders for event in order.events if event.event_type == "SELL"), None)
    cancel = next(((event, order) for order in orders for event in order.events if event.event_type == "CANCEL"), None)
    recovery = sorted({platform for order in orders if order.order_type in {"HS", "TH"} for platform in _platform_values(order)})
    sale = sorted({platform for order in orders if order.order_type == "DG" or any(event.event_type == "SELL" for event in order.events) for platform in _platform_values(order)})
    notes = next((order.note.strip() for order in orders if order.order_type != "DG" and order.note and order.note.strip()), "-")
    return OrderDetailViewOut(
        execution_rows=_execution_rows(orders),
        finance_rows=_finance_rows(orders, action_model_rebate_nos=action_model_rebate_nos),
        operation_rows=_operation_rows(orders, account_description=account_description, account_images=account_images),
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
