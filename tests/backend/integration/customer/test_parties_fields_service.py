"""FORM-01 parties/fields 扩展字段服务：类型校验、写入与读取（BAS-04）。

定义来源是「客户建档」表单的自定义字段（order_form_fields / CUSTOMER / is_custom=1），
值落在 customers.form_extra。
"""
from __future__ import annotations

import pytest

from app.core.errors import NotFound, Validation
from app.domain.trade import OrderFormField
from app.shared import form_values as fields_module
from app.customers.customers import create_customer, update_customer
from app.customers.counterparties import create_counterparty, update_counterparty
from app.shared.form_values import get_extra_values, get_extra_values_bulk, set_extra_values


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


def test_required_multiselect_cannot_be_empty_on_customer_creation(seeded_db):
    _add_field(seeded_db, "required_choices", field_type="MULTI_SELECT",
               options=[{"value": "A", "label": "甲"}], required=True)
    with pytest.raises(Validation, match="required_choices"):
        create_customer(seeded_db, display_name="空多选", actor="pytest", extra_values={"required_choices": []})


@pytest.mark.parametrize("conditional", [False, True])
def test_required_customer_text_rejects_whitespace(seeded_db, conditional):
    _add_field(seeded_db, "reference")
    note = _add_field(seeded_db, "required_note", required=not conditional)
    if conditional:
        note.required_when = {"field": "reference", "op": "filled"}
        seeded_db.flush()
    with pytest.raises(Validation, match="required_note"):
        create_customer(seeded_db, display_name="空白客户", actor="pytest", extra_values={"reference": "是", "required_note": "  \t"})
    saved = create_customer(seeded_db, display_name="正常客户", actor="pytest", extra_values={"reference": "是", "required_note": " 有效 "})
    assert saved.form_extra["required_note"] == " 有效 "


def test_conditional_customer_field_is_required_when_triggered(seeded_db):
    _add_field(seeded_db, "kind", field_type="SELECT",
               options=[{"value": "A", "label": "甲"}, {"value": "B", "label": "乙"}])
    note = _add_field(seeded_db, "details")
    note.required_when = {"field": "kind", "op": "eq", "values": ["A"]}
    seeded_db.flush()
    with pytest.raises(Validation, match="details"):
        create_customer(seeded_db, display_name="缺条件字段", actor="pytest", extra_values={"kind": "A"})
    created = create_customer(seeded_db, display_name="不触发条件", actor="pytest", extra_values={"kind": "B"})
    assert created.form_extra == {"kind": "B"}


@pytest.mark.parametrize(("choice", "trigger"), [(True, "true"), (False, "false")])
def test_conditional_customer_field_matches_boolean_switch(seeded_db, choice, trigger):
    _add_field(seeded_db, "switch_value", field_type="BOOLEAN")
    note = _add_field(seeded_db, "switch_detail")
    note.required_when = {"field": "switch_value", "op": "eq", "values": [trigger]}
    seeded_db.flush()
    with pytest.raises(Validation, match="switch_detail"):
        create_customer(seeded_db, display_name="缺开关说明", actor="pytest", extra_values={"switch_value": choice})
    customer = create_customer(seeded_db, display_name="有开关说明", actor="pytest",
                               extra_values={"switch_value": choice, "switch_detail": "已确认"})
    assert customer.form_extra["switch_detail"] == "已确认"
    create_customer(seeded_db, display_name="未触发开关", actor="pytest", extra_values={"switch_value": not choice})


def test_conditional_customer_field_treats_whitespace_dependency_as_empty(seeded_db):
    _add_field(seeded_db, "optional_reference")
    note = _add_field(seeded_db, "reference_detail")
    note.required_when = {"field": "optional_reference", "op": "filled"}
    seeded_db.flush()
    customer = create_customer(seeded_db, display_name="空白依赖", actor="pytest",
                               extra_values={"optional_reference": "   "})
    assert "reference_detail" not in customer.form_extra


def test_conditional_customer_field_tracks_core_field_on_create_and_edit(seeded_db):
    _add_field(seeded_db, "source", is_custom=False)
    note = _add_field(seeded_db, "source_detail")
    note.required_when = {"field": "source", "op": "eq", "values": ["其他"]}
    seeded_db.flush()
    with pytest.raises(Validation, match="source_detail"):
        create_customer(seeded_db, display_name="缺来源说明", source="其他", actor="pytest")
    customer = create_customer(seeded_db, display_name="有来源客户", source="微信", actor="pytest")
    with pytest.raises(Validation, match="source_detail"):
        update_customer(seeded_db, customer.id, source="其他", actor="pytest")
    saved = update_customer(seeded_db, customer.id, source="其他", extra_values={"source_detail": "朋友介绍"}, actor="pytest")
    assert saved.form_extra["source_detail"] == "朋友介绍"


def test_conditional_counterparty_field_tracks_core_field_on_create_and_edit(seeded_db):
    _add_field(seeded_db, "source", is_custom=False, scope="COUNTERPARTY")
    note = _add_field(seeded_db, "source_detail", scope="COUNTERPARTY")
    note.required_when = {"field": "source", "op": "eq", "values": ["其他"]}
    seeded_db.flush()
    with pytest.raises(Validation, match="source_detail"):
        create_counterparty(seeded_db, display_name="缺来源合作方", type="PEER", source="其他", actor="pytest")
    party = create_counterparty(seeded_db, display_name="合作方", type="PEER", source="微信", actor="pytest")
    with pytest.raises(Validation, match="source_detail"):
        update_counterparty(seeded_db, party.id, source="其他", actor="pytest")
    saved = update_counterparty(seeded_db, party.id, source="其他", extra_values={"source_detail": "朋友介绍"}, actor="pytest")
    assert saved.form_extra["source_detail"] == "朋友介绍"


def test_customer_extra_fields_can_be_edited_via_api(seeded_client, seeded_db, headers):
    _add_field(seeded_db, "remark")
    customer = create_customer(seeded_db, display_name="字段编辑客户", actor="pytest", extra_values={"remark": "旧值"})
    saved = seeded_client.patch(f"/api/v1/customers/{customer.id}", headers=headers,
                                json={"extra_values": {"remark": "新值"}})
    assert saved.status_code == 200, saved.text
    assert saved.json()["extra_values"]["remark"] == "新值"


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


# --------------------------------------------------------------- 选项读取
def test_option_values_requires_canonical_objects(seeded_db):
    field = _add_field(
        seeded_db, "opt", field_type="SELECT",
        options=[{"value": "A", "label": "甲"}, {"value": "B", "label": "乙"}],
    )
    assert fields_module._option_values(field) == ["A", "B"]

    legacy = _add_field(seeded_db, "legacy_opt", field_type="SELECT", options=["A"])
    with pytest.raises(Validation, match="字段选项须为对象"):
        fields_module._option_values(legacy)


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
    # DATE 口径统一（FORM-01）：两域共用 normalize_date_value，带时间后缀的
    # 历史脏数据归一化为 YYYY-MM-DD，不再出现「客户域拒绝/订单域截前 10 位」漂移。
    assert fields_module._validate_extra_value(field, "2026-10-01T12:30:00") == "2026-10-01"
    assert fields_module._validate_extra_value(field, "2026-10-01 12:30:00") == "2026-10-01"


def test_validate_select(seeded_db):
    field = _field(
        seeded_db,
        "SELECT",
        [{"value": "优质", "label": "优质"}, {"value": "观察", "label": "观察"}],
    )
    with pytest.raises(Validation, match="必须为字符串"):
        fields_module._validate_extra_value(field, 1)
    with pytest.raises(Validation, match="取值必须在选项内"):
        fields_module._validate_extra_value(field, "不存在")
    assert fields_module._validate_extra_value(field, "优质") == "优质"

    empty = _add_field(seeded_db, "select_empty", field_type="SELECT", options=[])
    with pytest.raises(Validation, match="未配置有效选项"):
        fields_module._validate_extra_value(empty, "优质")


def test_validate_multi_select(seeded_db):
    field = _field(
        seeded_db,
        "MULTI_SELECT",
        [{"value": "A", "label": "A"}, {"value": "B", "label": "B"}],
    )
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


def test_validate_text_and_rejects_unknown_type(seeded_db):
    field = _field(seeded_db, "TEXT")
    with pytest.raises(Validation, match="必须为字符串"):
        fields_module._validate_extra_value(field, 1)
    assert fields_module._validate_extra_value(field, "说明") == "说明"

    # 未知类型受 DB CHECK 约束无法入库，服务层也不再保留兜底转换。
    unknown = OrderFormField(
        order_type_code="CUSTOMER", field_key="legacy", label="legacy",
        field_type="LEGACY", is_custom=True,
    )
    with pytest.raises(Validation, match="字段类型不支持"):
        fields_module._validate_extra_value(unknown, 7)


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


def test_set_values_clears_explicit_empty_values(seeded_db):
    _add_field(seeded_db, "clearable")
    customer = _customer(seeded_db)
    _set(seeded_db, customer.id, [("clearable", "原值")])
    _set(seeded_db, customer.id, [("clearable", None)])
    assert get_extra_values(seeded_db, entity_type="customer", entity_id=customer.id) == {}


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
    # 非人员模块的公共调用点仍允许空入参，但拒绝实际写入。
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
