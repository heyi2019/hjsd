"""orders.export_fields：订单台账导出的列定义、分组表头与明细行展开。

只含纯常量与纯函数，不依赖 router 的权限注入与事务；
/orders/export.csv 与 /orders/export.xlsx 共用同一套口径。
"""
from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.domain.foundation import Pool
from app.domain.trade import Account, Order
from app.domain.users import User
from app.settings.lists import service as list_columns_service
from app.settings.lists.export import detail_json

# 订单表单里的经办人字段：存用户 id 数组，导出前翻成姓名。
RESPONSIBLE_ID_KEYS = ("business_responsible_ids", "delivery_responsible_ids", "sell_delivery_responsible_ids", "operation_responsible_ids")

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
# 展示列与界面业务口径一致；事件号、流水号和来源字段用于导入去重与还原关联。
ORDER_EVENT_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("event_no", "事件号", True),
    ("import_sequence", "事件顺序", True),
    ("operation_category", "操作分类", True),
    ("event_type", "动作", True),
    ("operation_type", "运营动作", True),
    ("sale_mode", "结算方式", True),
    ("delivery_direction", "交付方向", True),
    ("portion", "金额归属", True),
    ("import_pool_code", "资金账户编码", True),
    ("import_offset_no", "冲销来源事件号", True),
    ("import_source_type", "来源类型", True),
    ("import_source_id", "来源编号", True),
    ("import_is_posted", "已过账", True),
    ("platform", "平台", True),
    ("occurred_on", "动作时间", True),
    ("operator", "操作人", True),
    ("amount", "金额", True),
    ("note", "备注", True),
    ("reason", "原因", True),
    ("import_form_extra", "运营详情(JSON)", True),
    ("import_parent_no", "关联上架事件号", True),
]

# 「现金性质」与「方向」是同一信息的两种写法（本方流入⟺收入、本方流出⟺支出，实测一一对应），
# 导出流水号与来源编号以便导入时核对关联，避免重复记账。
CASHFLOW_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("flow_no", "流水号", True),
    ("category", "业务类别", True),
    ("import_category", "业务类别编码", True),
    ("direction", "方向", True),
    ("amount", "金额", True),
    ("occurred_on", "时间", True),
    ("operator", "操作人", True),
    ("pool_name", "资金账户", True),
    ("pool_code", "资金账户编码", True),
    ("accounting_attribute", "核算属性", True),
    ("import_source_type", "来源类型", True),
    ("import_source_id", "来源编号", True),
    ("note", "备注", True),
]

REBATE_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("rebate_no", "返点单号", True),
    ("rebate_type", "返点类型", True),
    ("channel", "渠道", True),
    ("amount", "返点金额", True),
    ("collected_on", "收到日期", True),
    ("pool_code", "资金账户编码", True),
    ("operator", "操作人", True),
    ("note", "备注", True),
]

# 已拆成独立 sheet 的明细列：xlsx 详情 sheet 里不再重复输出 JSON 版本，
# CSV 是单表格式没有承载位置，仍保留这些 JSON 列。
DETAIL_COLUMNS_MOVED_TO_SHEETS = frozenset(
    {"detail_events", "detail_cashflows", "detail_rebates"}
)

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


def _detail_value_labels(db: Session) -> dict[str, dict[str, str]]:
    """订单详情的动态字典，供导出和回流核对使用。"""
    from app.domain.options import OptionSet
    from app.shared.game_references import game_reference_labels
    codes = ("COMPENSATION_TYPE", "INTERMEDIARY_PLATFORM", "INTERMEDIARY_TYPE")
    labels = list_columns_service.option_labels_by_code(db, codes)
    result = {code.lower(): labels[code] for code in codes if code in labels}
    platform = db.scalar(select(OptionSet).where(OptionSet.code == "INTERMEDIARY_PLATFORM"))
    result["intermediary_platform_behavior"] = {
        item["value"]: item["behavior"] for item in (platform.options or []) if item.get("behavior")
    } if platform else {}
    _games, result["channel_region"] = game_reference_labels(db)
    return result


def _account_export_profiles(db: Session, orders: Sequence[Order]) -> dict[int, dict[str, object]]:
    """批量读取当前库存资料；图片只取数量，不加载图片内容。"""
    account_ids = {order.account_id for order in orders if order.account_id is not None}
    if not account_ids:
        return {}
    image_count = case(
        (func.json_typeof(Account.account_images) == "array", func.json_array_length(Account.account_images)),
        else_=0,
    ).label("account_image_count")
    profiles = db.execute(select(
        Account.id, Account.channel_region, Account.bound_phone, Account.has_secondary,
        Account.account_description, image_count,
    ).where(Account.id.in_(account_ids))).mappings().all()
    return {profile["id"]: dict(profile) for profile in profiles}


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
            "event_no": event.get("event_no"),
            "import_sequence": event.get("import_sequence"),
            "operation_category": _operation_category(event.get("event_type")),
            "event_type": event.get("event_type"),
            "operation_type": event.get("operation_type"),
            "sale_mode": event.get("sale_mode"),
            "delivery_direction": event.get("delivery_direction"),
            "portion": event.get("portion"),
            "import_pool_code": event.get("import_pool_code"),
            "import_offset_no": event.get("import_offset_no"),
            "import_source_type": event.get("import_source_type"),
            "import_source_id": event.get("import_source_id"),
            "import_is_posted": event.get("import_is_posted"),
            "platform": _event_platform(event, detail),
            "occurred_on": event.get("occurred_on"),
            "operator": event.get("operator"),
            "amount": _money_or_none(event.get("amount")),
            "note": event.get("note"),
            "reason": event.get("reason"),
            "import_form_extra": event.get("import_form_extra"),
            "import_parent_no": event.get("import_parent_no"),
        }
        for event in detail.get("events") or []
    ]


def _cashflow_export_rows(
    order_no: str, detail: dict, pool_names: dict[int, str]
) -> list[dict[str, object]]:
    return [
        {
            "order_no": order_no,
            "flow_no": flow.get("flow_no"),
            "category": flow.get("category"),
            "import_category": flow.get("import_category"),
            "direction": flow.get("direction"),
            "amount": _money_or_none(flow.get("amount")),
            "occurred_on": flow.get("occurred_on"),
            "operator": flow.get("operator"),
            "pool_name": pool_names.get(flow.get("pool_id")),
            "pool_code": flow.get("pool_code"),
            "accounting_attribute": flow.get("accounting_attribute"),
            "import_source_type": flow.get("import_source_type"),
            "import_source_id": flow.get("import_source_id"),
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
                "collected_on": rebate.get("collected_on"),
                "pool_code": rebate.get("pool_code"),
                "operator": rebate.get("operator"),
                "note": rebate.get("note"),
            }
        )
    return rows


def _delivery_export_fields(
    detail: dict, value_labels: dict[str, dict[str, str]],
    form_extra: dict[str, object] | None = None,
) -> dict[str, str | None]:
    """分别导出同一订单的买号和卖号交付信息。"""
    if form_extra is None:
        form_extra = detail.get("form_extra") or {}
    compensation_labels = value_labels.get("compensation_type") or {}
    snapshots = detail.get("option_label_snapshot") or {}
    def label_for(group: str, value: object) -> object:
        return value_labels.get(group, {}).get(value, value) if isinstance(value, str) else value
    def values_for(prefix: str) -> dict[str, str | None]:
        compensation = form_extra.get(f"{prefix}compensation_type")
        platform_code = form_extra.get(f"{prefix}intermediary_platform")
        platform = snapshots.get(f"{prefix}intermediary_platform") or label_for("intermediary_platform", platform_code)
        other_platform = form_extra.get(f"{prefix}intermediary_platform_other")
        if isinstance(platform_code, str) and value_labels.get("intermediary_platform_behavior", {}).get(platform_code) == "OTHER" and isinstance(other_platform, str) and other_platform.strip():
            platform = f"{platform}（{other_platform.strip()}）"
        return {
            "phone": form_extra.get(f"{prefix}bound_phone"),
            "owner": form_extra.get(f"{prefix}bound_phone_owner"),
            "platform": platform,
            "type": snapshots.get(f"{prefix}intermediary_type") or label_for("intermediary_type", form_extra.get(f"{prefix}intermediary_type")),
            "compensation": snapshots.get(f"{prefix}compensation_type") or (compensation_labels.get(compensation, compensation) if isinstance(compensation, str) else compensation),
            "responsible": detail_json(form_extra.get(f"{prefix}delivery_responsible_ids") or [], value_labels),
        }
    buy_values = values_for("")
    sell_values = values_for("sell_")
    return {
        **{f"detail_buy_delivery_{suffix}": value for suffix, value in buy_values.items()},
        **{f"detail_sell_delivery_{suffix}": value for suffix, value in sell_values.items()},
    }


def _order_detail_export_fields(
    detail: dict, value_labels: dict[str, dict[str, str]],
    user_names: dict[int, str] | None = None,
    account_profile: dict[str, object] | None = None,
) -> dict[str, str | None]:
    account = account_profile if account_profile is not None else (detail.get("account_snapshot") or {})
    snapshot = detail.get("account_snapshot") or {}
    form_extra = _translate_responsible_ids(detail.get("form_extra") or {}, user_names)
    history_labels = {key: dict(labels) for key, labels in value_labels.items()}
    for key, label in (detail.get("option_label_snapshot") or {}).items():
        value = form_extra.get(key)
        if isinstance(value, str) and isinstance(label, str):
            history_labels.setdefault(key, {})[value] = label
    has_secondary = account.get("has_secondary")
    image_count = account.get("account_image_count")
    if image_count is None:
        image_count = len(account.get("account_images") or [])
    return {
        "detail_account_channel_region": (snapshot.get("channel_region_label") if snapshot.get("channel_region") == account.get("channel_region") else None) or value_labels.get("channel_region", {}).get(account.get("channel_region"), account.get("channel_region")),
        "detail_account_bound_phone": account.get("bound_phone"),
        "detail_account_secondary": None if has_secondary is None else ("有" if has_secondary else "无"),
        "detail_account_description": account.get("account_description"),
        "detail_account_images": f"{image_count}张" if image_count else "",
        "detail_order_note": detail.get("note"),
        "detail_order_extra": detail_json(form_extra, history_labels),
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
    "_detail_value_labels",
    "_account_export_profiles",
    "_pool_name_map",
    "user_name_map",
    "_event_platform",
    "_order_event_export_rows",
    "_cashflow_export_rows",
    "_rebate_export_rows",
    "_order_detail_export_fields",
]
