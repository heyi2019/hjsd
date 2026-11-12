"""FORM-01 parties/fields 扩展字段服务：类型校验、写入与读取（BAS-04）。

定义来源是「客户建档」表单的自定义字段（order_form_fields / CUSTOMER / is_custom=1），
值落在 customers.form_extra。
"""
from __future__ import annotations

import pytest

from app.core.errors import NotFound, Validation
from app.domain.trade import OrderFormField
from app.parties import fields as fields_module
from app.parties.customers import create_customer
from app.parties.fields import get_extra_values, get_extra_values_bulk, set_extra_values


def _add_field(seeded_db, field_key: str, *, field_type: str = "TEXT", options=None,
               required: bool = False, is_custom: bool = True, is_active: bool = True,
               scope: str = "CUSTOMER", label: str | None = None) -> OrderFormField:
    field = OrderFormField(
        order_type_code=scope,
        field_key=field_key,
        label=label or field_key,
        field_type=field_type,
        options=options,
        required=required,
        is_active=is_active,
        is_custom=is_custom,
        sort_order=1000,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(field)
    seeded_db.flush()
    return field


def _customer(seeded_db, name: str = "甲"):
    customer = create_customer(seeded_db, display_name=name, actor="pytest")
    seeded_db.flush()
    return customer


def _set(seeded_db, customer_id: int, pairs: list[tuple[str, object]], **kwargs):
    return set_extra_values(
        seeded_db, entity_type="customer", entity_id=customer_id, values=pairs, **kwargs
    )


# --------------------------------------------------------------- 定义来源
def test_definitions_only_include_customer_custom_fields(seeded_db):
    _add_field(seeded_db, "extra_a")
    _add_field(seeded_db, "preset_b", is_custom=False)
    _add_field(seeded_db, "inactive_c", is_active=False)
    _add_field(seeded_db, "other_scope_d", scope="COUNTERPARTY")

    keys = [d.field_key for d in fields_module._extra_definitions(seeded_db, "customer")]
    assert keys == ["extra_a"]
    # 非客户实体暂无定义源
    assert fields_module._extra_definitions(seeded_db, "order") == []


def test_definitions_required_only_filter(seeded_db):
    _add_field(seeded_db, "must", required=True)
    _add_field(seeded_db, "may", required=False)
    required = fields_module._extra_definitions(seeded_db, "customer", required_only=True)
    assert [d.field_key for d in required] == ["must"]


# --------------------------------------------------------------- 选项归一化
def test_option_values_accepts_strings_and_objects(seeded_db):
    field = _add_field(
        seeded_db, "opt", field_type="SELECT",
        options=["A", {"value": "B", "label": "乙"}, "  ", 3, {"label": "无值"}],
    )
    assert fields_module._option_values(field) == ["A", "B"]


# --------------------------------------------------------------- 类型校验
def _field(seeded_db, field_type: str, options=None):
    return _add_field(seeded_db, f"probe_{field_type.lower()}", field_type=field_type, options=options)


def test_validate_value_none_passthrough(seeded_db):
    assert fields_module._validate_extra_value(_field(seeded_db, "TEXT"), None) is None


def test_validate_number_rejects_bool_and_text(seeded_db):
    field = _field(seeded_db, "NUMBER")
    with pytest.raises(Validation, match="必须为数字"):
        fields_module._validate_extra_value(field, True)
    with pytest.raises(Validation, match="必须为数字"):
        fields_module._validate_extra_value(field, "12")
    assert fields_module._validate_extra_value(field, 12) == 12


def test_validate_boolean(seeded_db):
    field = _field(seeded_db, "BOOLEAN")
    with pytest.raises(Validation, match="必须为布尔值"):
        fields_module._validate_extra_value(field, "true")
    assert fields_module._validate_extra_value(field, False) is False


def test_validate_date(seeded_db):
    field = _field(seeded_db, "DATE")
    with pytest.raises(Validation, match="YYYY-MM-DD"):
        fields_module._validate_extra_value(field, "2026/10/01")
    assert fields_module._validate_extra_value(field, " 2026-10-01 ") == "2026-10-01"


def test_validate_select(seeded_db):
    field = _field(seeded_db, "SELECT", ["优质", "观察"])
    with pytest.raises(Validation, match="必须为字符串"):
        fields_module._validate_extra_value(field, 1)
    with pytest.raises(Validation, match="取值必须在选项内"):
        fields_module._validate_extra_value(field, "不存在")
    assert fields_module._validate_extra_value(field, "优质") == "优质"

    empty = _add_field(seeded_db, "select_empty", field_type="SELECT", options=[])
    with pytest.raises(Validation, match="未配置有效选项"):
        fields_module._validate_extra_value(empty, "优质")


def test_validate_multi_select(seeded_db):
    field = _field(seeded_db, "MULTI_SELECT", ["A", "B"])
    with pytest.raises(Validation, match="必须为数组"):
        fields_module._validate_extra_value(field, "A")
    with pytest.raises(Validation, match="选项必须为字符串"):
        fields_module._validate_extra_value(field, [1])
    with pytest.raises(Validation, match="取值必须在选项内"):
        fields_module._validate_extra_value(field, ["A", "A"])
    with pytest.raises(Validation, match="取值必须在选项内"):
        fields_module._validate_extra_value(field, ["C"])
    assert fields_module._validate_extra_value(field, ["A", "B"]) == ["A", "B"]

    empty = _add_field(seeded_db, "multi_empty", field_type="MULTI_SELECT", options=[])
    with pytest.raises(Validation, match="未配置有效选项"):
        fields_module._validate_extra_value(empty, ["A"])


def test_validate_text_and_unknown_type(seeded_db):
    field = _field(seeded_db, "TEXT")
    with pytest.raises(Validation, match="必须为字符串"):
        fields_module._validate_extra_value(field, 1)
    assert fields_module._validate_extra_value(field, "说明") == "说明"

    # 未知类型受 DB CHECK 约束无法入库，直接按对象校验兜底分支
    unknown = OrderFormField(
        order_type_code="CUSTOMER", field_key="legacy", label="legacy",
        field_type="LEGACY", is_custom=True,
    )
    assert fields_module._validate_extra_value(unknown, 7) == "7"


# --------------------------------------------------------------- 写入
def test_set_values_rejects_unknown_field(seeded_db):
    customer = _customer(seeded_db)
    with pytest.raises(Validation, match="未启用或不存在"):
        _set(seeded_db, customer.id, [("ghost", "值")])


def test_set_values_rejects_duplicate_keys(seeded_db):
    _add_field(seeded_db, "dup")
    customer = _customer(seeded_db)
    with pytest.raises(Validation, match="不能重复提交"):
        _set(seeded_db, customer.id, [("dup", "a"), ("dup", "b")])


def test_set_values_requires_positive_entity_id(seeded_db):
    with pytest.raises(Validation, match="实体 ID 必须为正整数"):
        _set(seeded_db, 0, [("any", "值")])


def test_set_values_missing_customer(seeded_db):
    _add_field(seeded_db, "note_x")
    with pytest.raises(NotFound, match="客户 999999 不存在"):
        _set(seeded_db, 999999, [("note_x", "值")])


def test_set_values_merges_without_dropping_history(seeded_db):
    _add_field(seeded_db, "k1")
    _add_field(seeded_db, "k2")
    customer = _customer(seeded_db)
    _set(seeded_db, customer.id, [("k1", "v1")])
    saved = _set(seeded_db, customer.id, [("k2", "v2")])
    assert saved == {"k2": "v2"}
    assert get_extra_values(
        seeded_db, entity_type="customer", entity_id=customer.id
    ) == {"k1": "v1", "k2": "v2"}


def test_set_values_require_all_enforces_required_fields(seeded_db):
    customer = _customer(seeded_db)
    _add_field(seeded_db, "must", required=True)
    with pytest.raises(Validation, match="必填扩展字段未填写"):
        _set(seeded_db, customer.id, [], require_all=True)
    with pytest.raises(Validation, match="必填扩展字段未填写"):
        _set(seeded_db, customer.id, [("must", "")], require_all=True)


def test_set_values_empty_input_is_noop(seeded_db):
    customer = _customer(seeded_db)
    assert _set(seeded_db, customer.id, []) == {}


def test_set_values_rejects_non_customer_entities(seeded_db):
    # 其余实体暂无扩展字段体系：空入参兼容放行，非空入参拒绝
    assert set_extra_values(
        seeded_db, entity_type="order", entity_id=1, values=[]
    ) == {}
    with pytest.raises(Validation, match="该实体未启用扩展字段"):
        set_extra_values(
            seeded_db, entity_type="order", entity_id=1, values=[("k", "v")]
        )


# --------------------------------------------------------------- 读取
def test_get_values_for_non_customer_returns_empty(seeded_db):
    assert get_extra_values(
        seeded_db, entity_type="order", entity_id=1
    ) == {}


def test_get_values_missing_customer_returns_empty(seeded_db):
    assert get_extra_values(
        seeded_db, entity_type="customer", entity_id=999999
    ) == {}


def test_bulk_values(seeded_db):
    _add_field(seeded_db, "k1")
    first = _customer(seeded_db, "甲")
    second = _customer(seeded_db, "乙")
    _set(seeded_db, first.id, [("k1", "a")])
    bulk = get_extra_values_bulk(
        seeded_db, entity_type="customer", entity_ids=[first.id, second.id]
    )
    assert bulk[first.id] == {"k1": "a"}
    assert bulk[second.id] == {}


def test_bulk_values_empty_and_non_customer(seeded_db):
    assert get_extra_values_bulk(
        seeded_db, entity_type="customer", entity_ids=[]
    ) == {}
    assert get_extra_values_bulk(
        seeded_db, entity_type="order", entity_ids=[1, 2]
    ) == {1: {}, 2: {}}
