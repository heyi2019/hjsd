"""内置系统配置种子：选项词典与表单字段。"""
from __future__ import annotations

import base64
from functools import lru_cache
import json
import zlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import AuditAction
from app.domain.options import CUSTOM_DICTIONARY_REGISTRY, OptionSet
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
    "SYSPOOL": [("name", "名称", "TEXT", True), ("pool_type", "用途类型", "SELECT", True), ("is_default", "默认账户", "BOOLEAN", False), ("note", "备注", "TEXT", False)],
    "SYSPERIOD": [("start_day", "每月起始日", "NUMBER", True)],
}


def seed_system_form_fields(session: Session, *, actor: str = "system", existing_fields: dict[tuple[str, str], OrderFormField] | None = None) -> None:
    if existing_fields is None:
        existing_fields = {(row.order_type_code, row.field_key): row for row in session.scalars(select(OrderFormField)).all()}
    for code, fields in SYSTEM_FORM_FIELDS.items():
        for index, (key, label, field_type, required) in enumerate(fields):
            if (code, key) not in existing_fields:
                field = OrderFormField(order_type_code=code, field_key=key, label=label,
                    field_type=field_type, required=required, is_active=True, locked=required,
                    is_custom=False, sort_order=index * 10, section="EXTRA", created_by=actor, updated_by=actor)
                session.add(field)
                existing_fields[(code, key)] = field
    session.flush()


def seed_business_responsible_fields(session: Session, *, actor: str = "system", existing_fields: dict[tuple[str, str], OrderFormField] | None = None) -> None:
    """注册三类建单负责人字段；重复执行不覆盖管理员已保存的配置。"""
    if existing_fields is None:
        existing_fields = {(row.order_type_code, row.field_key): row for row in session.scalars(select(OrderFormField)).all()}
    for order_type_code, label in BUSINESS_RESPONSIBLE_FIELD_SEEDS:
        key = (order_type_code, "business_responsible_ids")
        if key in existing_fields:
            continue
        field = OrderFormField(
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
        session.add(field)
        existing_fields[key] = field

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
    "GAME_TYPE_DELETE": "删除游戏类型",
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


@lru_cache(maxsize=1)
def builtin_option_set_policy() -> tuple[frozenset[str], frozenset[str]]:
    """系统词典不可删除；后端固定取值的词典不受历史 editable 标记影响。"""
    data = json.loads(zlib.decompress(base64.b64decode(_CATALOG_BLOB)))
    builtins = frozenset(row["code"] for row in data["option_sets"]) | {"BUSINESS_PERIOD", "GAME_REFERENCE_ARCHIVE", "OPTION_ITEM_ARCHIVE", CUSTOM_DICTIONARY_REGISTRY}
    fixed = frozenset(row["code"] for row in data["option_sets"] if not row.get("editable")) | {
        "ALLOCATION_TYPE", "BUSINESS_PERIOD", "GAME_REFERENCE_ARCHIVE", "OPTION_ITEM_ARCHIVE", CUSTOM_DICTIONARY_REGISTRY,
    }
    return builtins, fixed


def accounting_attribute_options() -> list[dict[str, str]]:
    """核算属性展示与导出复用前端统一文案对应表；取值由领域枚举约束。"""
    from app.domain.enums import AccountingAttribute
    from app.settings.lists.export_labels import CASHFLOW_VALUE_LABELS

    labels = CASHFLOW_VALUE_LABELS["accounting_attribute"]
    return [{"value": code, "label": label} for code, label in labels.items() if code in AccountingAttribute.values()]


def _normalized_option_set(values: dict) -> dict:
    """Return the current option dictionary without retired business concepts."""
    if values.get("code") == "SEQUENCE_KEY":
        from app.settings.field_definitions.sequences import RETIRED_SEQUENCE_KEYS
        return {**values, "options": [item for item in (values.get("options") or []) if item.get("value") not in RETIRED_SEQUENCE_KEYS]}
    if values.get("code") == "FUND_FLOW_ACCOUNTING_ATTRIBUTE":
        return {**values, "editable": False, "options": accounting_attribute_options()}
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
    session.flush()
    existing_options = {row.code: row for row in session.scalars(select(OptionSet)).all()}
    existing_fields = {(row.order_type_code, row.field_key): row for row in session.scalars(select(OrderFormField)).all()}
    if "BUSINESS_PERIOD" not in existing_options:
        period = OptionSet(code="BUSINESS_PERIOD", label="当期设置", group="BUSINESS", editable=False,
            options=[{"value": "start_day", "label": "16"}], description="每月周期起始日",
            created_by=actor, updated_by=actor)
        session.add(period)
        existing_options[period.code] = period
    data = json.loads(zlib.decompress(base64.b64decode(_CATALOG_BLOB)))
    for raw_values in data["option_sets"]:
        values = _normalized_option_set(raw_values)
        existing = existing_options.get(values["code"])
        if existing:
            if values["code"] == "SEQUENCE_KEY":
                normalized = _normalized_option_set({"code": existing.code, "options": existing.options})["options"]
                if existing.options != normalized:
                    existing.options = normalized
                    existing.updated_by = actor
            # 审计动作是只读系统字典，产品文案变更时要修正已有 dev/本地库，
            # 不能只在首次建库时写入，否则旧库会持续覆盖前端固定口径。
            if values["code"] == "AUDIT_ACTION" and existing.options != values["options"]:
                existing.options = values["options"]
                existing.updated_by = actor
            continue
        values = {**values, "created_by": actor, "updated_by": actor}
        item = OptionSet(**values)
        session.add(item)
        existing_options[item.code] = item
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
        key = (values["order_type_code"], values["field_key"])
        exists = existing_fields.get(key)
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
        item = OrderFormField(**values)
        session.add(item)
        existing_fields[key] = item
    seed_business_responsible_fields(session, actor=actor, existing_fields=existing_fields)
    seed_system_form_fields(session, actor=actor, existing_fields=existing_fields)
    session.flush()
