"""动态字段服务拆分后的独立契约测试。

后半部分为覆盖率收口：直接调用 `_normalize_*` / `_validate_extra_value` 等
纯函数与各入口的守卫分支（既有契约测试只覆盖了文本/数字的 happy path）。
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.errors import NotFound, Validation
from app.domain.parties import FieldDefinition
from app.domain.trade import Installment
from app.parties import fields
from app.parties import service as parties_service


def test_field_module_creates_and_lists_definition(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="service_note",
        label="服务备注",
        actor="pytest",
    )

    listed = fields.list_field_definitions(seeded_db, entity_type="customer")

    assert [item.field_key for item in listed] == [definition.field_key]


def test_field_module_writes_and_reads_entity_values(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="service_score",
        label="服务评分",
        field_type="NUMBER",
        actor="pytest",
    )
    customer = parties_service.create_customer(
        seeded_db, display_name="动态字段测试客户", actor="pytest"
    )

    fields.set_extra_values(
        seeded_db,
        entity_type="customer",
        entity_id=customer.id,
        values=[(definition.field_key, 5)],
    )

    assert fields.get_extra_values(
        seeded_db, entity_type="customer", entity_id=customer.id
    ) == {definition.field_key: 5}


def test_field_module_keeps_number_validation(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="service_amount",
        label="服务金额",
        field_type="NUMBER",
        actor="pytest",
    )
    customer = parties_service.create_customer(
        seeded_db, display_name="动态字段校验客户", actor="pytest"
    )

    with pytest.raises(Validation, match="服务金额 必须为数字"):
        fields.set_extra_values(
            seeded_db,
            entity_type="customer",
            entity_id=customer.id,
            values=[(definition.field_key, "not-a-number")],
        )


def _def(field_type: str, *, options=None, rule=None, label="活字段"):
    """内存态定义对象：_validate_extra_value 只看 label/type/options/rule。"""
    return FieldDefinition(
        entity_type="customer",
        field_key="k",
        label=label,
        field_type=field_type,
        options=options,
        validation_rule=rule,
    )


# ------------------------------------------------------------ 选项规范化
def test_normalize_field_options_rejects_string(seeded_db):
    with pytest.raises(Validation, match="字段选项必须为字符串数组"):
        fields._normalize_field_options("SELECT", "A,B")  # 34-35


def test_normalize_field_options_rejects_non_select_type(seeded_db):
    with pytest.raises(Validation, match="非选择型字段不能配置选项"):
        fields._normalize_field_options("TEXT", ["A"])  # 39-43


# ------------------------------------------------- 适用业务类型规范化
def test_normalize_applicable_order_types_rejects_string(seeded_db):
    with pytest.raises(Validation, match="适用业务类型必须为字符串数组"):
        fields._normalize_applicable_order_types("HS")  # 68-72


def test_normalize_applicable_order_types_rejects_bad_code(seeded_db):
    with pytest.raises(Validation, match="适用业务类型必须为 2-10 位"):
        fields._normalize_applicable_order_types(["x"])  # 74-80


def test_normalize_applicable_order_types_rejects_duplicate(seeded_db):
    with pytest.raises(Validation, match="适用业务类型不能重复"):
        fields._normalize_applicable_order_types(["HS", "hs"])  # 82-86


# ------------------------------------------------------- 校验规则规范化
def test_normalize_validation_rule_rejects_non_mapping(seeded_db):
    with pytest.raises(Validation, match="校验规则必须为对象"):
        fields._normalize_validation_rule("TEXT", "min=1")  # 95-96


def test_normalize_validation_rule_rejects_unknown_key(seeded_db):
    with pytest.raises(Validation, match="不支持的键"):
        fields._normalize_validation_rule("TEXT", {"nope": 1})  # 98-103


def test_normalize_validation_rule_rejects_non_number_bound(seeded_db):
    with pytest.raises(Validation, match="校验规则 min 必须为数字"):
        fields._normalize_validation_rule("NUMBER", {"min": "1"})  # 106-113


def test_normalize_validation_rule_rejects_min_over_max(seeded_db):
    with pytest.raises(Validation, match="最小值不能大于最大值"):
        fields._normalize_validation_rule("NUMBER", {"min": 10, "max": 1})  # 114-115


def test_normalize_validation_rule_rejects_bad_length(seeded_db):
    with pytest.raises(Validation, match="max_length 必须为非负整数"):
        fields._normalize_validation_rule("TEXT", {"max_length": True})  # 116-125


def test_normalize_validation_rule_rejects_min_length_over_max(seeded_db):
    with pytest.raises(Validation, match="最小长度不能大于最大长度"):
        fields._normalize_validation_rule(
            "TEXT", {"min_length": 5, "max_length": 2}
        )  # 126-127


def test_normalize_validation_rule_rejects_empty_pattern(seeded_db):
    with pytest.raises(Validation, match="pattern 必须为非空字符串"):
        fields._normalize_validation_rule("TEXT", {"pattern": ""})  # 128-130


def test_normalize_validation_rule_rejects_invalid_pattern(seeded_db):
    with pytest.raises(Validation, match="不是有效正则表达式"):
        fields._normalize_validation_rule("TEXT", {"pattern": "([a-z"})  # 131-134


def test_normalize_validation_rule_rejects_minmax_on_non_number(seeded_db):
    with pytest.raises(Validation, match="只有数字字段可以配置 min/max"):
        fields._normalize_validation_rule("TEXT", {"min": 1})  # 135-136


# ------------------------------------------------------- 活字段值类型校验
def test_validate_extra_value_none_passthrough(seeded_db):
    assert fields._validate_extra_value(_def("TEXT"), None) is None  # 146-147


def test_validate_extra_number_below_min(seeded_db):
    with pytest.raises(Validation, match="不能小于"):
        fields._validate_extra_value(_def("NUMBER", rule={"min": 5}), 1)  # 156-160


def test_validate_extra_number_above_max(seeded_db):
    with pytest.raises(Validation, match="不能大于"):
        fields._validate_extra_value(_def("NUMBER", rule={"max": 5}), 9)  # 161-165


def test_validate_extra_boolean_rejects_non_bool(seeded_db):
    with pytest.raises(Validation, match="必须为布尔值"):
        fields._validate_extra_value(_def("BOOLEAN"), "yes")  # 167-172


def test_validate_extra_boolean_accepts_false(seeded_db):
    assert fields._validate_extra_value(_def("BOOLEAN"), False) is False  # 173


def test_validate_extra_date_rejects_bad_text(seeded_db):
    with pytest.raises(Validation, match="YYYY-MM-DD"):
        fields._validate_extra_value(_def("DATE"), "2026/01/02")  # 174-182


def test_validate_extra_date_trims_text(seeded_db):
    assert fields._validate_extra_value(_def("DATE"), " 2026-01-02 ") == "2026-01-02"  # 183


def test_validate_extra_select_rejects_non_string(seeded_db):
    with pytest.raises(Validation, match="必须为字符串"):
        fields._validate_extra_value(_def("SELECT", options=["A"]), 1)  # 184-189


def test_validate_extra_select_requires_options(seeded_db):
    with pytest.raises(Validation, match="未配置有效选项"):
        fields._validate_extra_value(_def("SELECT"), "A")  # 190-195


def test_validate_extra_multi_select_rejects_non_list(seeded_db):
    with pytest.raises(Validation, match="必须为数组"):
        fields._validate_extra_value(_def("MULTI_SELECT", options=["A"]), "A")  # 202-207


def test_validate_extra_multi_select_rejects_non_string_item(seeded_db):
    with pytest.raises(Validation, match="选项必须为字符串"):
        fields._validate_extra_value(_def("MULTI_SELECT", options=["A"]), [1])  # 208-212


def test_validate_extra_multi_select_requires_options(seeded_db):
    with pytest.raises(Validation, match="未配置有效选项"):
        fields._validate_extra_value(_def("MULTI_SELECT"), ["A"])  # 213-218


def test_validate_extra_multi_select_rejects_duplicate_value(seeded_db):
    with pytest.raises(Validation, match="取值必须在选项内"):
        fields._validate_extra_value(
            _def("MULTI_SELECT", options=["A", "B"]), ["A", "A"]
        )  # 219-223


def test_validate_extra_text_rejects_non_string(seeded_db):
    with pytest.raises(Validation, match="必须为字符串"):
        fields._validate_extra_value(_def("TEXT"), 5)  # 225-230


def test_validate_extra_text_rejects_too_short(seeded_db):
    with pytest.raises(Validation, match="长度不能少于"):
        fields._validate_extra_value(_def("TEXT", rule={"min_length": 5}), "ab")  # 232-236


def test_validate_extra_text_rejects_too_long(seeded_db):
    with pytest.raises(Validation, match="长度不能超过"):
        fields._validate_extra_value(_def("TEXT", rule={"max_length": 2}), "abcd")  # 237-241


def test_validate_extra_text_rejects_pattern_mismatch(seeded_db):
    with pytest.raises(Validation, match="格式不符合要求"):
        fields._validate_extra_value(
            _def("TEXT", rule={"pattern": "^[A-Z]+$"}), "abc"
        )  # 242-246


def test_validate_extra_unknown_type_coerces_to_string(seeded_db):
    assert fields._validate_extra_value(_def("WHATEVER"), 5) == "5"  # 248


# ------------------------------------------------------- 实体适用性校验
def test_validate_extra_values_rejects_unknown_entity_type(seeded_db):
    with pytest.raises(Validation, match="实体类型必须为"):
        fields._validate_extra_values(
            seeded_db, entity_type="unknown", entity_id=None, values=[]
        )  # 258-262


def test_validate_extra_values_rejects_non_positive_entity_id(seeded_db):
    with pytest.raises(Validation, match="实体 ID 必须为正整数"):
        fields._validate_extra_values(
            seeded_db, entity_type="customer", entity_id=0, values=[]
        )  # 263-269


def test_validate_extra_values_account_without_order(seeded_db):
    """账号实体没有任何关联订单 → 业务类型取不到，跳过适用性校验。"""
    from app.accounts import service as accounts_service

    account = accounts_service.create_account(
        seeded_db,
        game_account="fields-no-order-account",
        platform="王者",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    fields.create_field_definition(
        seeded_db,
        entity_type="account",
        field_key="acct_note",
        label="账号备注",
        applicable_order_types=["ZZ"],
        actor="pytest",
    )
    validated = fields._validate_extra_values(
        seeded_db,
        entity_type="account",
        entity_id=account.id,
        values=[("acct_note", "可用")],
    )  # 300-306（order 为 None 分支）
    assert [key for key, _, _ in validated] == ["acct_note"]


def test_validate_extra_values_installment_rejects_other_order_type(seeded_db):
    """分期实体 → 回查所属订单的业务类型做适用性校验。"""
    from app.orders import service as orders_service

    order = orders_service.create_order(
        seeded_db, order_type="DFQ", trade_date=date(2026, 10, 12), actor="pytest"
    )
    installment = Installment(
        inst_no="INST-FIELD-1",
        order_id=order.id,
        contract_type="ADVANCE_PURCHASE",
        periods=1,
    )
    seeded_db.add(installment)
    fields.create_field_definition(
        seeded_db,
        entity_type="installment",
        field_key="inst_note",
        label="分期备注",
        applicable_order_types=["ZZ"],
        actor="pytest",
    )
    seeded_db.flush()
    with pytest.raises(Validation, match="不适用于业务 DFQ"):
        fields._validate_extra_values(
            seeded_db,
            entity_type="installment",
            entity_id=installment.id,
            values=[("inst_note", "可用")],
        )  # 295-299 + 307


# ------------------------------------------------------------- 定义编辑/删除
def test_update_field_definition_not_found(seeded_db):
    with pytest.raises(NotFound, match="字段定义 999999 不存在"):
        fields.update_field_definition(seeded_db, 999999, actor="pytest")  # 473-478


def test_update_field_definition_allows_required_without_default(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="required_no_default",
        label="必填无默认",
        actor="pytest",
    )
    definition.required = True
    seeded_db.flush()
    updated = fields.update_field_definition(
        seeded_db, definition.id, actor="pytest", label="必填无默认2"
    )
    assert updated.label == "必填无默认2"  # 513-517（必填无默认值仍允许）


def test_update_field_definition_rejects_non_bool_required(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="required_flag",
        label="是否必填",
        actor="pytest",
    )
    with pytest.raises(Validation, match="required 必须为布尔值"):
        fields.update_field_definition(
            seeded_db, definition.id, actor="pytest", required="yes"
        )  # 532-535


def test_update_field_definition_accepts_required_and_sort_order(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="required_and_sort",
        label="必填与排序",
        actor="pytest",
    )
    updated = fields.update_field_definition(
        seeded_db, definition.id, actor="pytest", required=True, sort_order=3
    )
    assert updated.required is True
    assert updated.sort_order == 3  # 536 / 539（合法值落库分支）


def test_update_field_definition_rejects_negative_sort_order(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="sort_field",
        label="排序字段",
        actor="pytest",
    )
    with pytest.raises(Validation, match="排序值必须为非负整数"):
        fields.update_field_definition(
            seeded_db, definition.id, actor="pytest", sort_order=-1
        )  # 536-539


def test_delete_field_definition_not_found(seeded_db):
    with pytest.raises(NotFound, match="字段定义 999999 不存在"):
        fields.delete_field_definition(seeded_db, 999999, actor="pytest")  # 712-716


# ------------------------------------------------------------- 活字段写入入口
def test_set_extra_values_rejects_duplicate_keys(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="dup_key",
        label="重复字段",
        actor="pytest",
    )
    customer = parties_service.create_customer(
        seeded_db, display_name="重复键客户", actor="pytest"
    )
    with pytest.raises(Validation, match="活字段不能重复提交"):
        fields.set_extra_values(
            seeded_db,
            entity_type="customer",
            entity_id=customer.id,
            values=[(definition.field_key, "a"), (definition.field_key, "b")],
        )  # 613-618


def test_set_extra_values_short_circuits_when_table_missing(seeded_db, monkeypatch):
    """建库早期（field_definitions 表尚未建立）不下查定义。"""

    class _Inspector:
        @staticmethod
        def has_table(name: str) -> bool:
            return False

    monkeypatch.setattr(fields, "inspect", lambda bind: _Inspector)
    assert (
        fields.set_extra_values(
            seeded_db, entity_type="customer", entity_id=1, values=[]
        )
        == {}
    )  # 609-612
