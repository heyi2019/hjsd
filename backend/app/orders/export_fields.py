"""orders.export_fields：订单台账导出的列定义、分组表头与明细行展开。

只含纯常量与纯函数，不依赖 router 的权限注入与事务；
/orders/export.csv 与 /orders/export.xlsx 共用同一套口径。
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.domain.foundation import Pool
from app.domain.users import User
from app.lists.export import detail_json

# 订单表单里的经办人字段：存用户 id 数组，导出前翻成姓名。
RESPONSIBLE_ID_KEYS = ("business_responsible_ids", "delivery_responsible_ids", "operation_responsible_ids")

ORDER_DETAIL_EXPORT_COLUMNS = [
    ("detail_account_channel_region", "渠道 / 区服", True),
    ("detail_account_bound_phone", "绑定手机号", True),
    ("detail_account_secondary", "有无二次", True),
    ("detail_account_description", "账号描述", True),
    ("detail_account_images", "账号图片", True),
    ("detail_order_note", "订单备注", True),
    ("detail_order_extra", "订单扩展字段", True),
    ("detail_buy_delivery_phone", "买号交付-换绑手机号", True),
    ("detail_buy_delivery_owner", "买号交付-手机号绑定人", True),
    ("detail_buy_delivery_platform", "买号交付-交易平台", True),
    ("detail_buy_delivery_type", "买号交付-中介类型", True),
    ("detail_buy_delivery_compensation", "买号交付-包赔类型", True),
    ("detail_buy_delivery_responsible", "买号交付-交付操作人", True),
    ("detail_sell_delivery_phone", "卖号交付-换绑手机号", True),
    ("detail_sell_delivery_owner", "卖号交付-手机号绑定人", True),
    ("detail_sell_delivery_platform", "卖号交付-交易平台", True),
    ("detail_sell_delivery_type", "卖号交付-中介类型", True),
    ("detail_sell_delivery_compensation", "卖号交付-包赔类型", True),
    ("detail_sell_delivery_responsible", "卖号交付-交付操作人", True),
    ("detail_events", "操作明细", True),
    ("detail_cashflows", "资金明细", True),
    ("detail_rebates", "返点明细", True),
    ("detail_installment", "分期合约", True),
    ("detail_installment_schedule", "分期计划", True),
    ("detail_links", "关联订单", True),
    ("detail_attachments", "附件", True),
    ("detail_audit", "审计记录", True),
]

# xlsx「详情信息」sheet 的分组表头：{列键: 一级板块名}，一级为真合并单元格。
# 只用于 /orders/export.xlsx；CSV 一律单行表头（导入解析以首个非空行为表头，多行会错位）。
# 详情 sheet 单独带「订单标识」组，用来承载跨 sheet 关联键（订单号）。
DETAIL_EXPORT_HEADER_GROUPS: dict[str, str] = {
    "order_no": "订单标识",
    "detail_account_channel_region": "账号详情",
    "detail_account_bound_phone": "账号详情",
    "detail_account_secondary": "账号详情",
    "detail_account_description": "账号详情",
    "detail_account_images": "账号详情",
    "detail_order_note": "订单信息",
    "detail_order_extra": "订单信息",
    "detail_buy_delivery_phone": "交付信息",
    "detail_buy_delivery_owner": "交付信息",
    "detail_buy_delivery_platform": "交付信息",
    "detail_buy_delivery_type": "交付信息",
    "detail_buy_delivery_compensation": "交付信息",
    "detail_buy_delivery_responsible": "交付信息",
    "detail_sell_delivery_phone": "交付信息",
    "detail_sell_delivery_owner": "交付信息",
    "detail_sell_delivery_platform": "交付信息",
    "detail_sell_delivery_type": "交付信息",
    "detail_sell_delivery_compensation": "交付信息",
    "detail_sell_delivery_responsible": "交付信息",
    "detail_events": "明细记录",
    "detail_cashflows": "明细记录",
    "detail_rebates": "明细记录",
    "detail_installment": "明细记录",
    "detail_installment_schedule": "明细记录",
    "detail_links": "明细记录",
    "detail_attachments": "明细记录",
    "detail_audit": "明细记录",
}

# xlsx「详情信息」sheet 的二级分组：{列键: 二级组名}。
# 只在「交付信息」下使用——同一套交付字段在不同订单角色下分属买号交付 / 卖号交付，
# 拆成两组后每张订单只在其中一组有值，另一组整行留空，比单一「交付方向」标注更直观。
DETAIL_EXPORT_SUB_GROUPS: dict[str, str] = {
    "detail_buy_delivery_phone": "买号交付",
    "detail_buy_delivery_owner": "买号交付",
    "detail_buy_delivery_platform": "买号交付",
    "detail_buy_delivery_type": "买号交付",
    "detail_buy_delivery_compensation": "买号交付",
    "detail_buy_delivery_responsible": "买号交付",
    "detail_sell_delivery_phone": "卖号交付",
    "detail_sell_delivery_owner": "卖号交付",
    "detail_sell_delivery_platform": "卖号交付",
    "detail_sell_delivery_type": "卖号交付",
    "detail_sell_delivery_compensation": "卖号交付",
    "detail_sell_delivery_responsible": "卖号交付",
}


# 明细类 sheet 的列定义：把原本塞在单个单元格里的 JSON 明细拆成真正的列。
# 一单多行、以「订单号」与主/详情 sheet 关联，Excel 里可直接筛选、求和、做透视。
#
# 列集合与界面「操作明细 / 资金明细」保持同一套业务口径：界面没有的系统内部字段
# （事件号、流水号、是否过账、金额归属）一律不出现，界面有的「平台」要补上，
# 否则同一个人从界面切到导出会看到两套列。
ORDER_EVENT_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("operation_category", "操作分类", True),
    ("event_type", "动作", True),
    ("platform", "平台", True),
    ("occurred_on", "动作时间", True),
    ("operator", "操作人", True),
    ("amount", "金额", True),
    ("note", "备注", True),
]

# 「现金性质」与「方向」是同一信息的两种写法（本方流入⟺收入、本方流出⟺支出，实测一一对应），
# 只保留业务人员看得懂的「方向」；流水号属系统编号，不导出。
CASHFLOW_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("category", "业务类别", True),
    ("direction", "方向", True),
    ("amount", "金额", True),
    ("occurred_on", "时间", True),
    ("operator", "操作人", True),
    ("pool_name", "资金账户", True),
    ("note", "备注", True),
]

REBATE_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("rebate_no", "返点单号", True),
    ("rebate_type", "返点类型", True),
    ("channel", "渠道", True),
    ("amount", "返点金额", True),
    ("link_status", "关联状态", True),
    ("status", "状态", True),
    ("collected_on", "收到日期", True),
    ("operator", "操作人", True),
    ("note", "备注", True),
]

# 已拆成独立 sheet 的明细列：xlsx 详情 sheet 里不再重复输出 JSON 版本，
# CSV 是单表格式没有承载位置，仍保留这些 JSON 列。
DETAIL_COLUMNS_MOVED_TO_SHEETS = frozenset(
    {"detail_events", "detail_cashflows", "detail_rebates"}
)

# 返点状态码没有对应的 option_sets 字典项（RebateStatus 是闭集枚举），
# 这里按枚举给中文，与前端状态标签保持同一套文案。
_REBATE_STATUS_LABELS = {
    "OPEN": "未结算",
    "PARTIALLY_SETTLED": "部分结算",
    "SETTLED": "已结清",
    "VOID": "失效",
}

# 操作分类与前端执行明细同规则：BUY 账号入库 / SELL 账号出库 / 其余账号运营。
_OPERATION_CATEGORY_BY_EVENT = {"BUY": "账号入库", "SELL": "账号出库"}
_OPERATION_CATEGORY_FALLBACK = "账号运营"


def _operation_category(event_type: str | None) -> str:
    return _OPERATION_CATEGORY_BY_EVENT.get(event_type or "", _OPERATION_CATEGORY_FALLBACK)


def _money_or_none(value: object) -> Decimal | None:
    """明细金额转 2 位 Decimal：xlsx 写成数值才可求和；空值保持空单元格。"""
    if value is None or value == "":
        return None
    try:
        return to_money(value)
    except ValueError:
        return None


def _pool_name_map(db: Session) -> dict[int, str]:
    return {pool.id: pool.name for pool in db.scalars(select(Pool)).all()}


def user_name_map(db: Session) -> dict[int, str]:
    """全量用户 {id: 显示名}：用户量级很小，导出时一次取回翻经办人字段。"""
    return {
        user.id: user.display_name or user.username
        for user in db.scalars(select(User)).all()
    }


def _translate_responsible_ids(
    form_extra: dict[str, object], user_names: dict[int, str] | None
) -> dict[str, object]:
    """把 form_extra 里的经办人 id 数组原位翻成姓名（未提供映射时保留原值）。"""
    if not user_names:
        return form_extra
    translated = dict(form_extra)
    for key in RESPONSIBLE_ID_KEYS:
        ids = translated.get(key)
        if isinstance(ids, list):
            translated[key] = "、".join(
                user_names.get(item, str(item))
                for item in ids
                if isinstance(item, int)
            ) or None
    return translated


def _event_platform(event: dict, detail: dict) -> str | None:
    """事件的「平台」列（寄售平台口径），与库存视角的执行明细同口径。

    - 非下架事件：无寄售平台语义，记「-」；
    - 下架（CANCEL）事件按「下架方式」区分：系统下架记「本系统」，平台下架记寄售平台，
      缺寄售平台时记「-」。
    """
    if event.get("event_type") != "CANCEL":
        return "-"
    extra = detail.get("form_extra") or {}
    if extra.get("platform_unlist_scope") == "SYSTEM":
        return "本系统"
    configured = extra.get("consignment_platforms")
    if isinstance(configured, list):
        configured = "、".join(str(item).strip() for item in configured if str(item).strip())
    return configured or "-"


def _order_event_export_rows(order_no: str, detail: dict) -> list[dict[str, object]]:
    return [
        {
            "order_no": order_no,
            "operation_category": _operation_category(event.get("event_type")),
            "event_type": event.get("event_type"),
            "platform": _event_platform(event, detail),
            "occurred_on": event.get("occurred_on"),
            "operator": event.get("operator"),
            "amount": _money_or_none(event.get("amount")),
            "note": event.get("note"),
        }
        for event in detail.get("events") or []
    ]


def _cashflow_export_rows(
    order_no: str, detail: dict, pool_names: dict[int, str]
) -> list[dict[str, object]]:
    return [
        {
            "order_no": order_no,
            "category": flow.get("category"),
            "direction": flow.get("direction"),
            "amount": _money_or_none(flow.get("amount")),
            "occurred_on": flow.get("occurred_on"),
            "operator": flow.get("operator"),
            "pool_name": pool_names.get(flow.get("pool_id")),
            "note": flow.get("note"),
        }
        for flow in detail.get("cashflows") or []
    ]


def _rebate_export_rows(order_no: str, detail: dict) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for rebate in detail.get("rebates") or []:
        rows.append(
            {
                "order_no": order_no,
                "rebate_no": rebate.get("rebate_no"),
                "rebate_type": rebate.get("rebate_type"),
                "channel": rebate.get("channel"),
                "amount": _money_or_none(rebate.get("amount")),
                "link_status": rebate.get("link_status"),
                "status": rebate.get("status"),
                "collected_on": rebate.get("collected_on"),
                "operator": rebate.get("operator"),
                "note": rebate.get("note"),
            }
        )
    return rows


def _delivery_direction(detail: dict) -> str:
    """判定订单的交付方向：买单交付给卖家，卖单交付给买家。

    - 已登记 SELL 事件 → 这张单是「卖出去」的那一单，交付对象是买家 → 卖号交付；
    - DG 代挂（零本金、建单即纳入库存代卖）→ 无论是否已成交都是替客户卖 → 卖号交付；
    - 其余（HS 回收 / TH 提号中纯买入未成交的单）→ 买号交付。
    与库存视角的「卖号交付单」判定同源（含 SELL 事件，或 DG 单）。
    """
    if detail.get("order_type") == "DG":
        return "卖号交付"
    events = detail.get("events") or []
    if any(event.get("event_type") == "SELL" for event in events):
        return "卖号交付"
    return "买号交付"


def _delivery_export_fields(
    detail: dict, value_labels: dict[str, dict[str, str]],
    form_extra: dict[str, object] | None = None,
) -> dict[str, str | None]:
    """把同一套交付字段按订单角色归入「买号交付」或「卖号交付」，另一组整组留空。

    交付字段都存在订单自己的 `form_extra` 里，语义随订单角色变化：
    买入未成交的单是对卖家的交接，卖出过的单与 DG 代挂单是对买家的交接。
    两组并存而非只标方向，是为了让人一眼看出这张单属于哪种交付。
    `form_extra` 允许传入已做经办人翻译的副本（导出前统一处理），缺省读详情原值。
    """
    if form_extra is None:
        form_extra = detail.get("form_extra") or {}
    compensation = form_extra.get("compensation_type")
    # 包赔类型是 option_sets 词典（COMPENSATION_TYPE，管理员可编辑）：
    # 导出按同一套「代码值 → 中文」翻译，未命中保留原值
    compensation_labels = value_labels.get("compensation_type") or {}
    values: dict[str, str | None] = {
        "phone": form_extra.get("bound_phone"),
        "owner": form_extra.get("bound_phone_owner"),
        "platform": form_extra.get("intermediary_platform"),
        "type": form_extra.get("intermediary_type"),
        "compensation": (
            compensation_labels.get(compensation, compensation)
            if isinstance(compensation, str) else compensation
        ),
        "responsible": detail_json(
            form_extra.get("delivery_responsible_ids") or [], value_labels
        ),
    }
    is_buy = _delivery_direction(detail) == "买号交付"
    buy_values = values if is_buy else dict.fromkeys(values)
    sell_values = dict.fromkeys(values) if is_buy else values
    return {
        **{f"detail_buy_delivery_{suffix}": value for suffix, value in buy_values.items()},
        **{f"detail_sell_delivery_{suffix}": value for suffix, value in sell_values.items()},
    }


def _order_detail_export_fields(
    detail: dict, value_labels: dict[str, dict[str, str]],
    user_names: dict[int, str] | None = None,
) -> dict[str, str | None]:
    account = detail.get("account_snapshot") or {}
    form_extra = _translate_responsible_ids(detail.get("form_extra") or {}, user_names)
    has_secondary = account.get("has_secondary")
    images = account.get("account_images") or []
    return {
        "detail_account_channel_region": account.get("channel_region"),
        "detail_account_bound_phone": account.get("bound_phone"),
        "detail_account_secondary": None if has_secondary is None else ("有" if has_secondary else "无"),
        "detail_account_description": account.get("account_description"),
        "detail_account_images": f"{len(images)}张" if images else "",
        "detail_order_note": detail.get("note"),
        "detail_order_extra": detail_json(form_extra, value_labels),
        **_delivery_export_fields(detail, value_labels, form_extra),
        "detail_events": detail_json(detail.get("events") or [], value_labels),
        "detail_cashflows": detail_json(detail.get("cashflows") or [], value_labels),
        "detail_rebates": detail_json(detail.get("rebates") or [], value_labels),
        "detail_installment": detail_json(detail.get("installment"), value_labels),
        "detail_installment_schedule": detail_json(detail.get("installment_schedule") or [], value_labels),
        "detail_links": detail_json(detail.get("links") or [], value_labels),
        "detail_attachments": detail_json(detail.get("attachments") or [], value_labels),
        "detail_audit": detail_json(detail.get("audit") or [], value_labels),
    }


__all__ = [
    "ORDER_DETAIL_EXPORT_COLUMNS",
    "DETAIL_EXPORT_HEADER_GROUPS",
    "DETAIL_EXPORT_SUB_GROUPS",
    "ORDER_EVENT_EXPORT_COLUMNS",
    "CASHFLOW_EXPORT_COLUMNS",
    "REBATE_EXPORT_COLUMNS",
    "DETAIL_COLUMNS_MOVED_TO_SHEETS",
    "_REBATE_STATUS_LABELS",
    "_pool_name_map",
    "user_name_map",
    "_event_platform",
    "_order_event_export_rows",
    "_cashflow_export_rows",
    "_rebate_export_rows",
    "_order_detail_export_fields",
]
