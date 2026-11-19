"""FORM-01 tests/backend/test_order_form_fields：建单表单字段配置 CRUD + 护栏。

覆盖：
- 服务层：新增/列出（按 code、含/不含停用）/编辑/启用停用/删除；
- 护栏：核心字段(locked)禁止删除、重复键冲突、字段类型/选项/键名校验；
- 路由层：5 个端点 + 权限（viewer 403）。

建单表单字段表由 create_all 落地（测试不走迁移），故用例自行造数，
不依赖 0002 迁移的种子。
"""
from __future__ import annotations

import pytest

from app.core.errors import Conflict, NotFound, Validation
from app.domain.trade import OrderFormField
from app.orders import form_fields as ff
from app.orders.schemas import OrderFormFieldCreate


# --------------------------------------------------------------------------- #
# 服务层
# --------------------------------------------------------------------------- #

def _seed_dependency(seeded_db, *, code: str = "HS", key: str = "src_pick") -> OrderFormField:
    row = ff.create_order_form_field(
        seeded_db,
        order_type_code=code,
        field_key=key,
        label="来源选择",
        actor="admin",
        field_type="SELECT",
        options=[{"value": "其他", "label": "其他"}, {"value": "微信", "label": "微信"}],
    )
    seeded_db.commit()
    return row

def _seed_conditional_pair(seeded_db) -> tuple[OrderFormField, OrderFormField]:
    """建依赖字段 + 条件字段（依赖前者等于「其他」）。"""
    dep = ff.create_order_form_field(
        seeded_db,
        order_type_code="HS",
        field_key="dep_src",
        label="来源X",
        actor="admin",
        field_type="SELECT",
        options=[{"value": "其他", "label": "其他"}, {"value": "微信", "label": "微信"}],
    )
    cond = ff.create_order_form_field(
        seeded_db,
        order_type_code="HS",
        field_key="dep_other",
        label="其他来源X",
        actor="admin",
        required_when={"field": "dep_src", "op": "eq", "values": ["其他"]},
    )
    seeded_db.commit()
    return dep, cond

def test_create_and_list_custom_field(seeded_db):
    created = ff.create_order_form_field(
        seeded_db,
        order_type_code="HS",
        field_key="extra_tag",
        label="自定义标签",
        actor="admin",
        field_type="TEXT",
        required=False,
    )
    seeded_db.commit()
    assert created.id is not None
    assert created.locked is False
    assert created.is_custom is True

    rows = ff.list_order_form_fields(seeded_db, order_type_code="HS")
    assert len(rows) == 1
    assert rows[0].field_key == "extra_tag"
    # 小写键自动规范化
    assert rows[0].field_key == "extra_tag"

def test_operation_section_is_supported_for_custom_field(seeded_db):
    created = ff.create_order_form_field(
        seeded_db,
        order_type_code="INVEDIT",
        field_key="consignment_note",
        label="寄售运营备注",
        actor="admin",
        section="OPERATION",
    )
    seeded_db.commit()

    assert created.section == "OPERATION"

    updated = ff.update_order_form_field(
        seeded_db, created.id, actor="admin", section="OPERATION"
    )
    assert updated.section == "OPERATION"

def test_custom_section_key_is_supported_for_custom_field(seeded_db):
    created = ff.create_order_form_field(
        seeded_db,
        order_type_code="INVEDIT",
        field_key="custom_ops_note",
        label="自定义运营备注",
        actor="admin",
        section="CUSTOM_OPS",
    )
    seeded_db.commit()

    assert created.section == "CUSTOM_OPS"

def test_list_filters_inactive(seeded_db):
    ff.create_order_form_field(
        seeded_db, order_type_code="TH", field_key="a", label="A", actor="admin"
    )
    ff.create_order_form_field(
        seeded_db, order_type_code="TH", field_key="b", label="B", actor="admin", is_active=False
    )
    seeded_db.commit()

    all_rows = ff.list_order_form_fields(seeded_db, order_type_code="TH", include_inactive=True)
    assert len(all_rows) == 2
    active_only = ff.list_order_form_fields(seeded_db, order_type_code="TH", include_inactive=False)
    assert len(active_only) == 1
    assert active_only[0].field_key == "a"

def test_list_isolated_by_code(seeded_db):
    ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="x", label="X", actor="admin"
    )
    ff.create_order_form_field(
        seeded_db, order_type_code="DG", field_key="y", label="Y", actor="admin"
    )
    seeded_db.commit()
    assert len(ff.list_order_form_fields(seeded_db, order_type_code="HS")) == 1
    assert len(ff.list_order_form_fields(seeded_db, order_type_code="DG")) == 1

def test_duplicate_key_conflict(seeded_db):
    ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="dup", label="Dup", actor="admin"
    )
    seeded_db.commit()
    with pytest.raises(Conflict):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="dup", label="Dup2", actor="admin"
        )

def test_update_field_label_required_options(seeded_db):
    created = ff.create_order_form_field(
        seeded_db,
        order_type_code="HS",
        field_key="src",
        label="来源",
        actor="admin",
        field_type="SELECT",
        options=[{"value": "微信", "label": "微信"}, {"value": "支付宝", "label": "支付宝"}],
    )
    seeded_db.commit()

    updated = ff.update_order_form_field(
        seeded_db, created.id, actor="admin", label="来源渠道", required=True
    )
    seeded_db.commit()
    assert updated.label == "来源渠道"
    assert updated.required is True
    # 选项保持不变（归一化为 {value,label} 对象数组）
    assert updated.options == [
        {"value": "微信", "label": "微信"},
        {"value": "支付宝", "label": "支付宝"},
    ]

def test_update_dynamic_select_field_rename_with_empty_options(seeded_db):
    """动态字典字段（库内 options 为空，如 game_type/payment_pool_id）编辑改名时
    前端会回传空选项数组，不应被「选择型字段至少需要一个选项」拦截（回归）。"""
    dynamic = OrderFormField(
        order_type_code="HS",
        field_key="dynamic_pick",
        label="动态选择",
        field_type="SELECT",
        options=None,
        locked=True,
        is_active=True,
        required=False,
        is_custom=False,
    )
    seeded_db.add(dynamic)
    seeded_db.commit()

    updated = ff.update_order_form_field(
        seeded_db, dynamic.id, actor="admin",
        label="动态选择改名", options=[], required=False,
        required_when=None, sort_order=0,
    )
    seeded_db.commit()
    assert updated.label == "动态选择改名"
    # 选项按「未变更」保持为空（运行时由主数据填充）
    assert updated.options is None
    assert updated.field_key == "dynamic_pick"

def test_fixed_term_field_label_cannot_be_renamed(seeded_db):
    """系统统一术语字段（payment_pool_id=资金账户）禁止改名；同值回传放行。

    口径：资金账户这一术语全站统一，配置中心只读展示，接口层做最终裁决。
    """
    core = OrderFormField(
        order_type_code="HS",
        field_key="payment_pool_id",
        label="资金账户",
        field_type="SELECT",
        options=None,
        locked=True,
        is_active=True,
        required=True,
        is_custom=False,
    )
    seeded_db.add(core)
    seeded_db.commit()

    with pytest.raises(Validation):
        ff.update_order_form_field(seeded_db, core.id, actor="admin", label="资金出处")
    seeded_db.rollback()

    # 前端整表提交会带回同值标签，必须放行（只拦真实改名）
    updated = ff.update_order_form_field(
        seeded_db, core.id, actor="admin", label="资金账户", required=False
    )
    seeded_db.commit()
    assert updated.label == "资金账户"
    assert updated.required is False

def test_update_dynamic_multiselect_field_rename_with_empty_options(seeded_db):
    """MULTI_SELECT 动态字典字段同样按「未变更」处理（与 SELECT 对称覆盖）。"""
    dynamic = OrderFormField(
        order_type_code="HS",
        field_key="dynamic_multi",
        label="动态多选",
        field_type="MULTI_SELECT",
        options=None,
        locked=True,
        is_active=True,
        required=False,
        is_custom=False,
    )
    seeded_db.add(dynamic)
    seeded_db.commit()

    updated = ff.update_order_form_field(
        seeded_db, dynamic.id, actor="admin",
        label="动态多选改名", options=[], required=False,
        required_when=None, sort_order=0,
    )
    seeded_db.commit()
    assert updated.label == "动态多选改名"
    assert updated.options is None

def test_update_static_select_field_empty_options_still_rejected(seeded_db):
    """有静态选项的 SELECT 字段，清空选项提交仍被护栏拦截。"""
    created = ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="static_sel", label="静态选择",
        actor="admin", field_type="SELECT", options=[{"value": "a", "label": "a"}, {"value": "b", "label": "b"}],
    )
    seeded_db.commit()
    with pytest.raises(Validation):
        ff.update_order_form_field(seeded_db, created.id, actor="admin", options=[])

def test_set_active_toggle(seeded_db):
    created = ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="tog", label="Tog", actor="admin"
    )
    seeded_db.commit()
    assert created.is_active is True

    ff.set_order_form_field_active(seeded_db, created.id, False, actor="admin")
    seeded_db.commit()
    row = seeded_db.get(OrderFormField, created.id)
    assert row.is_active is False

    ff.set_order_form_field_active(seeded_db, created.id, True, actor="admin")
    seeded_db.commit()
    assert seeded_db.get(OrderFormField, created.id).is_active is True

def test_locked_field_cannot_be_deleted(seeded_db):
    locked = OrderFormField(
        order_type_code="HS",
        field_key="game_account",
        label="游戏账号",
        field_type="TEXT",
        locked=True,
        is_active=True,
        required=True,
        is_custom=False,
    )
    seeded_db.add(locked)
    seeded_db.commit()

    with pytest.raises(Validation):
        ff.delete_order_form_field(seeded_db, locked.id, actor="admin")

def test_delete_custom_field_ok(seeded_db):
    created = ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="del", label="Del", actor="admin"
    )
    seeded_db.commit()
    ff.delete_order_form_field(seeded_db, created.id, actor="admin")
    seeded_db.commit()
    assert seeded_db.get(OrderFormField, created.id) is None

def test_update_missing_field_raises_not_found(seeded_db):
    with pytest.raises(NotFound):
        ff.update_order_form_field(seeded_db, 99999, actor="admin", label="x")

def test_field_type_validation(seeded_db):
    # 非选择型带选项 → 拒绝
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="k1", label="K1", actor="admin",
            field_type="TEXT", options=["a"],
        )
    # 选择型无选项 → 拒绝
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="k2", label="K2", actor="admin",
            field_type="SELECT",
        )
    # 选项重复 → 拒绝
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="k3", label="K3", actor="admin",
            field_type="SELECT", options=["a", "a"],
        )

def test_select_options_require_value_label_objects(seeded_db):
    with pytest.raises(Validation, match="字段选项须为对象"):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="object_options", label="对象选项",
            actor="admin", field_type="SELECT", options=["微信"],
        )

def test_field_key_and_code_pattern(seeded_db):
    # 非法字段键（大写开头）
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="BadKey", label="B", actor="admin"
        )
    # 非法 code（含特殊字符，大写规范化后仍不匹配 2-10 位字母数字）
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS@", field_key="good_key", label="B", actor="admin"
        )
    # 非法字段类型
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="good_key", label="B", actor="admin",
            field_type="BLOB",
        )

def test_router_create_and_list(seeded_client, headers):
    resp = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS",
            field_key="r_tag",
            label="路由标签",
            field_type="TEXT",
        ).model_dump(mode="json"),
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["field_key"] == "r_tag"
    assert body["locked"] is False
    assert body["is_custom"] is True

    listing = seeded_client.get(
        "/api/v1/order-form-fields", headers=headers, params={"order_type_code": "HS"}
    )
    assert listing.status_code == 200
    assert any(f["field_key"] == "r_tag" for f in listing.json())

def test_router_duplicate_conflict_409(seeded_client, headers):
    payload = OrderFormFieldCreate(
        order_type_code="HS", field_key="dup_rt", label="Dup", field_type="TEXT"
    ).model_dump(mode="json")
    first = seeded_client.post("/api/v1/order-form-fields", headers=headers, json=payload)
    assert first.status_code == 201
    second = seeded_client.post("/api/v1/order-form-fields", headers=headers, json=payload)
    assert second.status_code == 409
