"""内置系统配置种子：选项词典与表单字段。"""
from __future__ import annotations

import base64
from functools import lru_cache
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
+uOv/w+CVOZy
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
    builtins = frozenset(row["code"] for row in data["option_sets"]) | {"BUSINESS_PERIOD"}
    fixed = frozenset(row["code"] for row in data["option_sets"] if not row.get("editable")) | {
        "ALLOCATION_TYPE", "BUSINESS_PERIOD",
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
