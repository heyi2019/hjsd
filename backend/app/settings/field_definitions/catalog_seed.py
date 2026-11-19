"""内置系统配置种子：选项词典与表单字段。"""
from __future__ import annotations

import base64
import json
import zlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import AuditAction
from app.domain.options import OptionSet
from app.domain.trade_models.form_config import OrderFormField

SALE_PAYMENT_METHOD_OPTIONS = [
    {"value": "FULL", "label": "全款"},
    {"value": "INSTALLMENT", "label": "分期付款"},
]

# 三类账号订单的业务负责人是建单核心字段：选项来自当前在职员工，不来自配置中心手工维护。
# 配置中心仍需要有字段行，用于统一展示、必填和启停配置。
BUSINESS_RESPONSIBLE_FIELD_SEEDS = (
    ("HS", "回收操作人"),
    ("TH", "提号操作人"),
    ("DG", "代挂操作人"),
)

# 系统表单的内置字段；配置编辑器自身也保留字段定义，关键控件由前端强制保留。
SYSTEM_FORM_FIELDS = {
    "ORDDELETE": [("reason", "删除原因", "TEXT", True)],
    "INVDELETE": [("reason", "删除原因", "TEXT", True)],
    "SYSREMIND": [("inventoryAgingDays", "库存订单超过多少天提醒", "NUMBER", True), ("profitNotificationsEnabled", "新的分润通知", "BOOLEAN", False), ("overdueInstallmentsEnabled", "逾期合约提醒", "BOOLEAN", False)],
    "SYSGAME": [("game_type_name", "游戏类型", "TEXT", True), ("sort_order", "排序", "NUMBER", False), ("channel_regions", "渠道／区服", "MULTI_SELECT", False), ("is_default", "默认类型", "BOOLEAN", False)],
    "SYSDICT": [("option", "字典项", "TEXT", True)],
    "SYSFIELD": [("field_key", "字段键", "TEXT", True), ("label", "标签", "TEXT", True), ("field_type", "类型", "SELECT", False), ("section", "归属板块", "SELECT", False), ("flow_direction", "资金流向性质", "SELECT", False), ("options", "选项（值 / 展示名）", "MULTI_SELECT", False), ("required", "必填", "BOOLEAN", False), ("cond_field", "条件必填·依赖字段", "SELECT", False), ("cond_op", "条件", "SELECT", False), ("cond_values", "触发值", "MULTI_SELECT", False), ("sort_order", "排序", "NUMBER", False)],
    "SYSORDER": [("code", "代码", "TEXT", True), ("name", "名称", "TEXT", True), ("is_zero_principal", "零本金", "BOOLEAN", False), ("sequence_prefix", "编号前缀", "TEXT", False), ("sort_order", "排序", "NUMBER", False), ("description", "说明", "TEXT", False)],
    "SYSPOOL": [("code", "代码", "TEXT", True), ("name", "名称", "TEXT", True), ("pool_type", "用途类型", "SELECT", True), ("is_default", "默认账户", "BOOLEAN", False), ("note", "备注", "TEXT", False)],
}


def seed_system_form_fields(session: Session, *, actor: str = "system") -> None:
    for code, fields in SYSTEM_FORM_FIELDS.items():
        for index, (key, label, field_type, required) in enumerate(fields):
            existing = session.scalar(select(OrderFormField).where(OrderFormField.order_type_code == code, OrderFormField.field_key == key))
            if existing is None:
                session.add(OrderFormField(order_type_code=code, field_key=key, label=label,
                    field_type=field_type, required=required, is_active=True, locked=required,
                    is_custom=False, sort_order=index * 10, section="EXTRA", created_by=actor, updated_by=actor))
    session.flush()


def seed_business_responsible_fields(session: Session, *, actor: str = "system") -> None:
    """注册三类建单负责人字段；重复执行不覆盖管理员已保存的配置。"""
    for order_type_code, label in BUSINESS_RESPONSIBLE_FIELD_SEEDS:
        exists = session.scalar(
            select(OrderFormField).where(
                OrderFormField.order_type_code == order_type_code,
                OrderFormField.field_key == "business_responsible_ids",
            )
        )
        if exists:
            continue
        session.add(
            OrderFormField(
                order_type_code=order_type_code,
                field_key="business_responsible_ids",
                label=label,
                field_type="MULTI_SELECT",
                options=None,
                flow_direction=None,
                required=True,
                required_when=None,
                is_active=True,
                sort_order=1070,
                locked=True,
                is_custom=False,
                section="ACCOUNT_PRODUCT",
                note="默认当前员工，可多选",
                created_by=actor,
                updated_by=actor,
            )
        )

_CATALOG_BLOB = """
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
"""


_ORDER_EVENT_OPTIONS = [
    {"value": "BUY", "label": "买号"},
    {"value": "SELL", "label": "售出"},
    {"value": "DELIVER", "label": "交付"},
    {"value": "CANCEL", "label": "取消"},
    {"value": "OPERATE", "label": "运营"},
    {"value": "REBATE", "label": "返点"},
]
_AUDIT_ACTION_ADDITIONS = {
    "ACCOUNT_DELETE": "删除",
    "ORDER_DELETE": "删除",
    "LIST_COLUMNS_UPDATE": "列表列显示配置变更",
    "LIST_COLUMNS_RESET": "列表列配置恢复默认",
    "LIST_COLUMN_ADD": "列表新增自定义列",
    "LIST_COLUMN_REMOVE": "列表删除自定义列",
    "LIST_EXPORT": "导出列表",
    "REBATE_UPDATE": "编辑返点",
    "REBATE_DELETE": "删除返点",
}


def _normalized_option_set(values: dict) -> dict:
    """Return the current option dictionary without retired business concepts."""
    if values.get("code") != "ORDER_EVENT_TYPE":
        if values.get("code") != "AUDIT_ACTION":
            return values
        existing = {item.get("value"): item for item in (values.get("options") or [])}
        options = []
        for action in AuditAction:
            options.append(
                existing.get(
                    action.value,
                    {"value": action.value, "label": _AUDIT_ACTION_ADDITIONS.get(action.value, action.value)},
                )
            )
        return {**values, "options": options}
    return {**values, "options": [*(_ORDER_EVENT_OPTIONS)]}


def seed_catalog(session: Session, *, actor: str = "system") -> None:
    data = json.loads(zlib.decompress(base64.b64decode(_CATALOG_BLOB)))
    for raw_values in data["option_sets"]:
        values = _normalized_option_set(raw_values)
        existing = session.scalar(select(OptionSet).where(OptionSet.code == values["code"]))
        if existing:
            # 审计动作是只读系统字典，产品文案变更时要修正已有 dev/本地库，
            # 不能只在首次建库时写入，否则旧库会持续覆盖前端固定口径。
            if values["code"] == "AUDIT_ACTION" and existing.options != values["options"]:
                existing.options = values["options"]
                existing.updated_by = actor
            continue
        values = {**values, "created_by": actor, "updated_by": actor}
        session.add(OptionSet(**values))
    for values in data["order_form_fields"]:
        if (
            values["order_type_code"] == "ORDERCANC"
            and values["field_key"] == "cancel_amount"
        ):
            values = {**values, "flow_direction": "IN"}
        if (
            values["order_type_code"] in {"SALEREC", "SALETH"}
            and values["field_key"] == "payment_method"
            and not values.get("options")
        ):
            values = {**values, "options": SALE_PAYMENT_METHOD_OPTIONS}
        exists = session.scalar(
            select(OrderFormField).where(
                OrderFormField.order_type_code == values["order_type_code"],
                OrderFormField.field_key == values["field_key"],
            )
        )
        if exists:
            # 旧版作用域种子漏掉付款方式选项；仅修复空值，不覆盖管理员配置。
            if (
                exists.order_type_code in {"SALEREC", "SALETH"}
                and exists.field_key == "payment_method"
                and not exists.options
            ):
                exists.options = SALE_PAYMENT_METHOD_OPTIONS
            continue
        values = {**values, "created_by": actor, "updated_by": actor}
        session.add(OrderFormField(**values))
    seed_business_responsible_fields(session, actor=actor)
    seed_system_form_fields(session, actor=actor)
    session.flush()
