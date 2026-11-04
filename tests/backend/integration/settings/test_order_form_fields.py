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
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.domain.trade import OrderFormField, OrderFormSectionLabel
from app.orders import form_fields as ff
from app.orders.schemas import OrderFormFieldCreate, OrderFormFieldUpdate, SectionLabelsSaveIn


# --------------------------------------------------------------------------- #
# 服务层
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# 路由层
# --------------------------------------------------------------------------- #
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


def test_router_update_required_and_active(seeded_client, headers):
    created = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="rt_u", label="RtU", field_type="TEXT"
        ).model_dump(mode="json"),
    ).json()

    upd = seeded_client.patch(
        f"/api/v1/order-form-fields/{created['id']}",
        headers=headers,
        json=OrderFormFieldUpdate(required=True, label="RtU2").model_dump(mode="json", exclude_none=True),
    )
    assert upd.status_code == 200
    assert upd.json()["required"] is True
    assert upd.json()["label"] == "RtU2"

    dis = seeded_client.patch(
        f"/api/v1/order-form-fields/{created['id']}/active",
        headers=headers,
        params={"active": "false"},
    )
    assert dis.status_code == 200
    assert dis.json()["is_active"] is False


def test_router_update_flow_direction_accepts_literal_string(seeded_client, headers):
    """编辑器保存资金流向性质时，Literal 值应按字符串传给领域层。"""
    created = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="rt_flow", label="流向字段", field_type="NUMBER"
        ).model_dump(mode="json"),
    ).json()

    upd = seeded_client.patch(
        f"/api/v1/order-form-fields/{created['id']}",
        headers=headers,
        json=OrderFormFieldUpdate(flow_direction="OUT").model_dump(mode="json", exclude_none=True),
    )

    assert upd.status_code == 200
    assert upd.json()["flow_direction"] == "OUT"


def test_router_dynamic_field_rename_with_empty_options(seeded_client, seeded_db, headers):
    """路由层回归：动态字典字段编辑改名时前端回传 options=[]，应 200 而非 422。"""
    dynamic = OrderFormField(
        order_type_code="HS",
        field_key="rt_dynamic",
        label="路由动态字段",
        field_type="SELECT",
        options=None,
        locked=True,
        is_active=True,
        required=False,
        is_custom=False,
    )
    seeded_db.add(dynamic)
    seeded_db.commit()

    resp = seeded_client.patch(
        f"/api/v1/order-form-fields/{dynamic.id}",
        headers=headers,
        json={"label": "路由动态字段改名", "options": [], "required": False,
              "required_when": None, "sort_order": 0},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["label"] == "路由动态字段改名"
    assert body["options"] in (None, [])


def test_router_dynamic_multiselect_rename_with_empty_options(seeded_client, seeded_db, headers):
    """路由层回归：MULTI_SELECT 动态字典字段编辑改名时前端回传 options=[]，应 200。"""
    dynamic = OrderFormField(
        order_type_code="HS",
        field_key="rt_dynamic_multi",
        label="路由动态多选",
        field_type="MULTI_SELECT",
        options=None,
        locked=True,
        is_active=True,
        required=False,
        is_custom=False,
    )
    seeded_db.add(dynamic)
    seeded_db.commit()

    resp = seeded_client.patch(
        f"/api/v1/order-form-fields/{dynamic.id}",
        headers=headers,
        json={"label": "路由动态多选改名", "options": [], "required": False,
              "required_when": None, "sort_order": 0},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["label"] == "路由动态多选改名"


def test_router_locked_delete_rejected_400(seeded_client, seeded_db, headers):
    locked = OrderFormField(
        order_type_code="HS",
        field_key="core_locked",
        label="核心字段",
        field_type="TEXT",
        locked=True,
        is_active=True,
        required=True,
        is_custom=False,
    )
    seeded_db.add(locked)
    seeded_db.commit()

    resp = seeded_client.delete(
        f"/api/v1/order-form-fields/{locked.id}", headers=headers
    )
    # 核心字段删除被 Validation 护栏拦截（HTTP 422）
    assert resp.status_code == 422
    # 行仍在
    assert seeded_db.get(OrderFormField, locked.id) is not None


def test_router_delete_custom_ok(seeded_client, headers):
    created = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="rt_del", label="RtDel", field_type="TEXT"
        ).model_dump(mode="json"),
    ).json()
    resp = seeded_client.delete(
        f"/api/v1/order-form-fields/{created['id']}", headers=headers
    )
    assert resp.status_code == 204


def test_router_permission_denied_for_viewer(seeded_client, viewer_headers):
    resp = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=viewer_headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="v_k", label="V", field_type="TEXT"
        ).model_dump(mode="json"),
    )
    assert resp.status_code == 403


def test_router_form_config_readable_by_operator(seeded_client, headers, operator_headers):
    """读端点只要求登录：非管理员角色必须拿到完整表单配置（2026-11-05 修正）。

    回归背景：三个 GET 原挂在 field-definition.manage（仅 ADMIN）下，OPERATOR /
    FINANCE / AUDITOR 一律 403；前端 useOrderFormConfig / useOrderFormSectionLabels
    在 catch 里降级为空配置，于是「管理员配好的自定义字段与板块标题」对非管理员
    彻底失效，界面上只留下两行 403 控制台报错。本用例锁住「读放开、写仍拦」。
    """
    # 管理员先配一个自定义字段 + 一个板块标题改名
    created = seeded_client.post(
        "/api/v1/order-form-fields", headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="op_readable", label="经办可见字段", field_type="TEXT",
        ).model_dump(mode="json"),
    )
    assert created.status_code == 201, created.text
    seeded_client.put(
        "/api/v1/order-form-fields/section-labels", headers=headers,
        json={"order_type_code": "HS", "labels": {"FINANCE": "资金明细（经办可见）"}},
    )

    # 1) 经办人读得到字段定义
    fields = seeded_client.get(
        "/api/v1/order-form-fields", headers=operator_headers,
        params={"order_type_code": "HS"},
    )
    assert fields.status_code == 200, fields.text
    assert any(row["field_key"] == "op_readable" for row in fields.json())

    # 2) 经办人读得到板块标题
    labels = seeded_client.get(
        "/api/v1/order-form-fields/section-labels", headers=operator_headers,
        params={"order_type_code": "HS"},
    )
    assert labels.status_code == 200, labels.text
    assert labels.json().get("FINANCE") == "资金明细（经办可见）"

    # 3) 经办人读得到作用域注册表
    scopes = seeded_client.get("/api/v1/order-form-fields/scopes", headers=operator_headers)
    assert scopes.status_code == 200, scopes.text
    assert scopes.json()

    # 4) 写仍然被拦：读放开不等于放开配置权
    denied_create = seeded_client.post(
        "/api/v1/order-form-fields", headers=operator_headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="op_write_try", label="越权", field_type="TEXT",
        ).model_dump(mode="json"),
    )
    assert denied_create.status_code == 403
    denied_labels = seeded_client.put(
        "/api/v1/order-form-fields/section-labels", headers=operator_headers,
        json={"order_type_code": "HS", "labels": {"FINANCE": "越权改名"}},
    )
    assert denied_labels.status_code == 403


def test_rename_persists_to_db_and_backfills_via_list_endpoint(seeded_client, headers):
    """闭环实证：设置页改名 → 落库 → 前端数据源(GET /order-form-fields)实时返回新名、旧名消失。

    前端 OrderFormFieldsPanel 保存后调 load() 重新 list；业务表单 useOrderFormConfig
    挂载时亦调 list。本用例验证 list 端点从 DB 实时读（无缓存），改名后取到的是新名。
    """
    # 1) 建一个字段（走与前端相同的创建端点）
    created = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="rt_backfill",
            label="回填探针原名", field_type="TEXT",
        ).model_dump(mode="json"),
    )
    assert created.status_code == 201, created.text
    fid = created.json()["id"]

    # 2) GET 列表：前端此刻拿到的就是"原名"（数据源读取验证）
    first = seeded_client.get(
        "/api/v1/order-form-fields", headers=headers,
        params={"order_type_code": "HS", "include_inactive": True},
    )
    assert first.status_code == 200, first.text
    first_labels = [f["label"] for f in first.json()]
    assert "回填探针原名" in first_labels

    # 3) 改名（走与设置页 submit 相同的 PATCH 端点）
    patched = seeded_client.patch(
        f"/api/v1/order-form-fields/{fid}", headers=headers,
        json={"label": "回填探针新名"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["label"] == "回填探针新名"

    # 4) 再次 GET 列表（前端重新拉取时）：新名在、旧名不在 —— 证明无陈旧缓存
    second = seeded_client.get(
        "/api/v1/order-form-fields", headers=headers,
        params={"order_type_code": "HS", "include_inactive": True},
    )
    second_labels = [f["label"] for f in second.json()]
    assert "回填探针新名" in second_labels
    assert "回填探针原名" not in second_labels


def test_router_requires_auth(seeded_client):
    resp = seeded_client.post(
        "/api/v1/order-form-fields",
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="noauth", label="N", field_type="TEXT"
        ).model_dump(mode="json"),
    )
    assert resp.status_code in (401, 403)


# --------------------------------------------------------------------------- #
# 条件必填（required_when）：必填 / 条件必填 / 选填 三态
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


def test_create_with_required_when(seeded_db):
    _seed_dependency(seeded_db)
    created = ff.create_order_form_field(
        seeded_db,
        order_type_code="HS",
        field_key="src_pick_other",
        label="其他来源",
        actor="admin",
        required=False,
        required_when={"field": "src_pick", "op": "eq", "values": ["其他"]},
    )
    seeded_db.commit()
    assert created.required is False
    assert created.required_when == {"field": "src_pick", "op": "eq", "values": ["其他"]}


def test_create_required_true_ignores_condition(seeded_db):
    _seed_dependency(seeded_db)
    created = ff.create_order_form_field(
        seeded_db,
        order_type_code="HS",
        field_key="must_fill",
        label="必填项",
        actor="admin",
        required=True,
        required_when={"field": "src_pick", "op": "eq", "values": ["其他"]},
    )
    seeded_db.commit()
    # 必填与条件必填互斥：required=True 时不落条件
    assert created.required_when is None


def test_update_sets_condition_then_required_clears_it(seeded_db):
    _seed_dependency(seeded_db)
    created = ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="cond_note", label="条件备注", actor="admin"
    )
    seeded_db.commit()

    updated = ff.update_order_form_field(
        seeded_db,
        created.id,
        actor="admin",
        required=False,
        required_when={"field": "src_pick", "op": "filled"},
    )
    seeded_db.commit()
    assert updated.required_when == {"field": "src_pick", "op": "filled", "values": None}

    # 切回必填 → 条件被清除
    back = ff.update_order_form_field(seeded_db, created.id, actor="admin", required=True)
    seeded_db.commit()
    assert back.required is True
    assert back.required_when is None


def test_update_condition_rejected_when_required(seeded_db):
    _seed_dependency(seeded_db)
    created = ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="req_first", label="先必填", actor="admin",
        required=True,
    )
    seeded_db.commit()
    with pytest.raises(Validation):
        ff.update_order_form_field(
            seeded_db,
            created.id,
            actor="admin",
            required_when={"field": "src_pick", "op": "filled"},
        )


@pytest.mark.parametrize(
    "condition",
    [
        {"field": "cond_self", "op": "eq", "values": ["x"]},  # 依赖自身
        {"field": "no_such_field", "op": "eq", "values": ["x"]},  # 依赖字段不存在
        {"field": "src_pick", "op": "gt", "values": ["x"]},  # 运算符非法
        {"field": "src_pick", "op": "eq", "values": []},  # 等于但无触发值
        {"field": "src_pick", "op": "filled", "values": ["x"]},  # 有值却给了触发值
        {"field": "", "op": "eq", "values": ["x"]},  # 空依赖字段
    ],
)
def test_required_when_validation_rejects(seeded_db, condition):
    _seed_dependency(seeded_db)
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db,
            order_type_code="HS",
            field_key="cond_self",
            label="条件字段",
            actor="admin",
            required_when=condition,
        )


def test_required_when_non_mapping_rejected(seeded_db):
    with pytest.raises(Validation):
        ff.create_order_form_field(
            seeded_db,
            order_type_code="HS",
            field_key="bad_cond",
            label="坏条件",
            actor="admin",
            required_when="src_pick=其他",
        )


def test_router_required_when_roundtrip(seeded_client, headers):
    dep = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="rt_src", label="路由来源", field_type="SELECT",
            options=[{"value": "其他", "label": "其他"}, {"value": "微信", "label": "微信"}],
        ).model_dump(mode="json"),
    ).json()

    created = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS",
            field_key="rt_other",
            label="路由其他来源",
            field_type="TEXT",
            required_when={"field": "rt_src", "op": "eq", "values": ["其他"]},
        ).model_dump(mode="json"),
    )
    assert created.status_code == 201, created.text
    assert created.json()["required_when"] == {"field": "rt_src", "op": "eq", "values": ["其他"]}

    # 显式 null → 清除条件（回退纯选填）
    cleared = seeded_client.patch(
        f"/api/v1/order-form-fields/{created.json()['id']}",
        headers=headers,
        json={"required_when": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["required_when"] is None

    # 不传 → 保持现状
    kept = seeded_client.patch(
        f"/api/v1/order-form-fields/{dep['id']}", headers=headers, json={"label": "路由来源2"}
    )
    assert kept.status_code == 200
    assert kept.json()["required_when"] is None


# --------------------------------------------------------------------------- #
# 依赖防护：被条件必填引用的字段不可停用/删除
# --------------------------------------------------------------------------- #
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


def test_deactivate_rejected_when_dependent(seeded_db):
    dep, _cond = _seed_conditional_pair(seeded_db)
    with pytest.raises(Validation) as exc:
        ff.set_order_form_field_active(seeded_db, dep.id, False, actor="admin")
    assert "其他来源X" in str(exc.value)
    assert exc.value.details["dependents"] == ["其他来源X"]
    seeded_db.rollback()
    # 状态未被改动
    seeded_db.expire_all()
    assert seeded_db.get(OrderFormField, dep.id).is_active is True


def test_deactivate_allowed_when_not_dependent(seeded_db):
    _dep, cond = _seed_conditional_pair(seeded_db)
    # 条件字段自身不被任何字段依赖 → 允许停用
    updated = ff.set_order_form_field_active(seeded_db, cond.id, False, actor="admin")
    seeded_db.commit()
    assert updated.is_active is False


def test_deactivate_is_idempotent_when_already_inactive(seeded_db):
    """已停用的字段再次停用直接通过（幂等），不因依赖而报错。"""
    dep, _cond = _seed_conditional_pair(seeded_db)
    dep.is_active = False  # 模拟历史已停用（如依赖是后来才加的）
    seeded_db.commit()
    updated = ff.set_order_form_field_active(seeded_db, dep.id, False, actor="admin")
    assert updated.is_active is False


def test_delete_rejected_when_dependent(seeded_db):
    dep, _cond = _seed_conditional_pair(seeded_db)
    with pytest.raises(Validation) as exc:
        ff.delete_order_form_field(seeded_db, dep.id, actor="admin")
    assert "无法删除" in str(exc.value)
    assert exc.value.details["field_key"] == "dep_src"


def test_delete_allowed_when_not_dependent(seeded_db):
    _dep, cond = _seed_conditional_pair(seeded_db)
    ff.delete_order_form_field(seeded_db, cond.id, actor="admin")
    seeded_db.commit()
    assert seeded_db.get(OrderFormField, cond.id) is None


def test_dependent_check_is_scoped_by_order_type(seeded_db):
    """别的业务类型下同名 key 的条件不应干扰本作用域的停用。"""
    _dep, _cond = _seed_conditional_pair(seeded_db)
    # TH 作用域建一个自己的字段，key 相同但不引用 HS 的字段
    other = ff.create_order_form_field(
        seeded_db, order_type_code="TH", field_key="dep_src", label="来源Y", actor="admin"
    )
    seeded_db.commit()
    updated = ff.set_order_form_field_active(seeded_db, other.id, False, actor="admin")
    seeded_db.commit()
    assert updated.is_active is False


def test_router_rejects_deactivate_dependent(seeded_client, headers):
    dep = seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS", field_key="rt_dep", label="路由依赖", field_type="TEXT"
        ).model_dump(mode="json"),
    ).json()
    seeded_client.post(
        "/api/v1/order-form-fields",
        headers=headers,
        json=OrderFormFieldCreate(
            order_type_code="HS",
            field_key="rt_dep_child",
            label="路由子字段",
            required_when={"field": "rt_dep", "op": "filled"},
        ).model_dump(mode="json"),
    )
    blocked = seeded_client.patch(
        f"/api/v1/order-form-fields/{dep['id']}/active?active=false", headers=headers
    )
    assert blocked.status_code == 422, blocked.text
    body = blocked.json()
    # 422 必须来自依赖防护（而非 schema 拒收字段）
    assert "路由子字段" in body["message"]
    assert body["details"]["dependents"] == ["路由子字段"]

    # 启用方向不受限
    enabled = seeded_client.patch(
        f"/api/v1/order-form-fields/{dep['id']}/active?active=true", headers=headers
    )
    assert enabled.status_code == 200, enabled.text


# --------------------------------------------------------------------------- #
# 改名引用一致性：对每个可配置字段改名，验证引用处（按 field_key 解析）同步更新
# --------------------------------------------------------------------------- #
def test_rename_every_configurable_field_updates_references(seeded_db):
    """防回归（用户质疑「改名后引用处是否更新」的实证）：

    造一组覆盖**全部字段类型 + 条件依赖网**的字段，对每个字段改名，断言：
    ① 改名落库且 field_key 不变 → 所有按 key 的引用天然存活；
    ② 重新拉取配置（复刻前端 fieldLabel(config,key) 的输入）拿到新名；
    ③ 被本字段引用的条件，其展示依赖标签解析到新名
       （复刻前端面板 OrderFormFieldsPanel 行188：
        rows.find(i => i.field_key === dep.required_when.field)?.label）。
    """
    # —— 造数：核心锁定 / 自定义 / SELECT(静态·动态空选项) / MULTI_SELECT(动态) / 依赖网 ——
    # 锁定字段（locked）服务层固定为 False，故直接建 ORM 对象（与既有动态字段测试一致）
    seeded_db.add(OrderFormField(
        order_type_code="HS", field_key="game_type", label="游戏类型",
        field_type="SELECT", options=None, locked=True, is_active=True,
        required=False, is_custom=False,
    ))
    seeded_db.add(OrderFormField(
        order_type_code="HS", field_key="buyer", label="买家",
        field_type="TEXT", locked=True, is_active=True,
        required=False, is_custom=False,
    ))
    ff.create_order_form_field(seeded_db, order_type_code="HS", field_key="pay_method",
        label="支付方式", actor="admin", field_type="SELECT",
        options=[{"value": "微信", "label": "微信"}, {"value": "支付宝", "label": "支付宝"}])
    # 动态 MULTI_SELECT（options 为空，运行时由主数据填充）同样以 ORM 直接建
    seeded_db.add(OrderFormField(
        order_type_code="HS", field_key="custom_tag", label="自定义标签",
        field_type="MULTI_SELECT", options=None, locked=True, is_active=True,
        required=False, is_custom=False,
    ))
    # 条件依赖：pay_method==微信 → custom_tag 必填；buyer 有值 → game_type 必填
    ff.create_order_form_field(seeded_db, order_type_code="HS", field_key="pm_other",
        label="渠道备注", actor="admin",
        required_when={"field": "pay_method", "op": "eq", "values": ["微信"]})
    ff.create_order_form_field(seeded_db, order_type_code="HS", field_key="gt_note",
        label="游戏备注", actor="admin", required_when={"field": "buyer", "op": "filled"})
    seeded_db.commit()

    all_rows = ff.list_order_form_fields(seeded_db, order_type_code="HS", include_inactive=True)
    assert len(all_rows) == 6

    # 计算每个字段被哪些条件引用（按 field_key，同作用域）
    references: dict[str, list[str]] = {}
    for r in all_rows:
        dep = (r.required_when or {}).get("field") if isinstance(r.required_when, dict) else None
        if dep:
            references.setdefault(dep, []).append(r.field_key)

    renamed = 0
    for row in all_rows:
        new_label = f"{row.label}·改名"
        ff.update_order_form_field(seeded_db, row.id, actor="admin", label=new_label)
        seeded_db.commit()

        # 复刻前端：重新拉取配置并建 map（fieldLabel 以 field_key 为键）
        fresh = ff.list_order_form_fields(seeded_db, order_type_code="HS")
        config_by_key = {r.field_key: r for r in fresh}

        # ① 自身 label 落库 + key 不变
        assert config_by_key[row.field_key].label == new_label
        assert config_by_key[row.field_key].field_key == row.field_key

        # ② 被本字段引用的条件，其展示依赖标签解析到新名
        for dependent_key in references.get(row.field_key, []):
            dep = config_by_key[dependent_key]
            resolved = config_by_key.get((dep.required_when or {}).get("field"))
            assert resolved is not None, f"条件引用断裂：{dependent_key} → {dep.required_when}"
            assert resolved.label == new_label
        renamed += 1

    assert renamed == 6

    # 改名后整表再校验：没有任何条件引用指向不存在的字段（无悬空引用）
    final = ff.list_order_form_fields(seeded_db, order_type_code="HS")
    keys = {r.field_key for r in final}
    for r in final:
        dep = (r.required_when or {}).get("field") if isinstance(r.required_when, dict) else None
        assert dep is None or dep in keys, f"悬空引用：{r.field_key} → {dep}"


# --------------------------------------------------------------------------- #
# 数据契约护栏：字段类型固定 + 核心字段不可停用
# --------------------------------------------------------------------------- #
def test_update_rejects_field_type_change(seeded_db):
    """字段类型创建后固定，禁止变更；历史 form_extra 值（字符串 vs 数组、类型语义）依赖类型。"""
    field = ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="ty_text", label="类型探针",
        actor="admin", field_type="TEXT",
    )
    seeded_db.commit()  # 确保持久化，跨 fixture 事务配置稳定
    with pytest.raises(Validation):
        ff.update_order_form_field(seeded_db, field.id, actor="admin", field_type="NUMBER")
    seeded_db.rollback()
    # 回传与原类型相同不拦截（编辑弹窗会回传原类型）
    ff.update_order_form_field(seeded_db, field.id, actor="admin", field_type="TEXT")
    seeded_db.commit()
    assert seeded_db.get(OrderFormField, field.id).field_type == "TEXT"


def test_set_active_rejects_locked_field(seeded_db):
    """核心字段(locked)不可停用：前端硬编码 Section 不读 is_active，停用将导致状态矛盾。"""
    locked = OrderFormField(
        order_type_code="HS", field_key="ty_locked", label="锁字探针",
        field_type="TEXT", locked=True, is_active=True, is_custom=False,
    )
    seeded_db.add(locked)
    seeded_db.commit()
    with pytest.raises(Validation):
        ff.set_order_form_field_active(seeded_db, locked.id, False, actor="admin")
    seeded_db.rollback()
    # 启用锁定字段不拦截
    ff.set_order_form_field_active(seeded_db, locked.id, True, actor="admin")
    seeded_db.commit()
    assert seeded_db.get(OrderFormField, locked.id).is_active is True


# --------------------------------------------------------------------------- #
# 板块标题（section labels）：落库 + 跨浏览器/用户共享
# --------------------------------------------------------------------------- #
def test_save_and_get_section_labels_roundtrip(seeded_db):
    """设置面板改板块名 → 落库 → 其他会话从同一业务类型读到新名（共享单一事实源）。"""
    before = ff.get_section_labels(seeded_db, order_type_code="TH")
    assert before == {}

    saved = ff.save_section_labels(
        seeded_db,
        order_type_code="TH",
        labels={"FINANCE": "资金明细改", "PARTICIPANT": "供货方信息改"},
        actor="admin",
    )
    seeded_db.commit()
    assert saved == {"FINANCE": "资金明细改", "PARTICIPANT": "供货方信息改"}

    # 同一业务类型重新读取，得到覆盖后映射（模拟另一个标签页/用户打开建单）
    reread = ff.get_section_labels(seeded_db, order_type_code="TH")
    assert reread == {"FINANCE": "资金明细改", "PARTICIPANT": "供货方信息改"}


def test_section_labels_empty_label_resets_to_default(seeded_db):
    """空标题 = 恢复默认：覆盖行被删除，读取映射中不再含该板块。"""
    ff.save_section_labels(seeded_db, order_type_code="HS", labels={"FINANCE": "资金明细改"}, actor="admin")
    seeded_db.commit()
    assert ff.get_section_labels(seeded_db, order_type_code="HS") == {"FINANCE": "资金明细改"}

    # 传空串 → 恢复默认
    ff.save_section_labels(seeded_db, order_type_code="HS", labels={"FINANCE": ""}, actor="admin")
    seeded_db.commit()
    assert ff.get_section_labels(seeded_db, order_type_code="HS") == {}
    # 物理行已删除
    rows = seeded_db.scalars(
        select(OrderFormSectionLabel).where(OrderFormSectionLabel.order_type_code == "HS")
    ).all()
    assert len(rows) == 0


def test_section_labels_isolated_by_order_type(seeded_db):
    """板块标题按业务类型隔离：TH 的改名不影响 DG。"""
    ff.save_section_labels(seeded_db, order_type_code="TH", labels={"FINANCE": "T"}, actor="admin")
    ff.save_section_labels(seeded_db, order_type_code="DG", labels={"FINANCE": "D"}, actor="admin")
    seeded_db.commit()
    assert ff.get_section_labels(seeded_db, order_type_code="TH") == {"FINANCE": "T"}
    assert ff.get_section_labels(seeded_db, order_type_code="DG") == {"FINANCE": "D"}


def test_section_labels_rejects_bad_code(seeded_db):
    with pytest.raises(Validation):
        ff.save_section_labels(seeded_db, order_type_code="HS@", labels={"FINANCE": "x"}, actor="admin")


def test_section_labels_rejects_bad_section_key(seeded_db):
    with pytest.raises(Validation):
        ff.save_section_labels(seeded_db, order_type_code="HS", labels={"bad key!": "x"}, actor="admin")
    with pytest.raises(Validation):
        ff.save_section_labels(seeded_db, order_type_code="HS", labels={"finance": "x"}, actor="admin")


def test_router_section_labels_roundtrip(seeded_client, headers):
    """路由层闭环：GET 初始为空 → PUT 覆盖 → GET 返回新名 → PUT 空串恢复默认。"""
    base = seeded_client.get(
        "/api/v1/order-form-fields/section-labels", headers=headers,
        params={"order_type_code": "TH"},
    )
    assert base.status_code == 200, base.text
    assert base.json() == {}

    saved = seeded_client.put(
        "/api/v1/order-form-fields/section-labels", headers=headers,
        json=SectionLabelsSaveIn(
            order_type_code="TH", labels={"FINANCE": "资金明细改名"}
        ).model_dump(mode="json"),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"FINANCE": "资金明细改名"}

    reread = seeded_client.get(
        "/api/v1/order-form-fields/section-labels", headers=headers,
        params={"order_type_code": "TH"},
    )
    assert reread.json() == {"FINANCE": "资金明细改名"}


def test_router_section_labels_requires_auth(seeded_client):
    resp = seeded_client.put(
        "/api/v1/order-form-fields/section-labels",
        json=SectionLabelsSaveIn(order_type_code="TH", labels={"FINANCE": "x"}).model_dump(mode="json"),
    )
    assert resp.status_code in (401, 403)


def test_router_section_labels_rejects_bad_section_key(seeded_client, headers):
    resp = seeded_client.put(
        "/api/v1/order-form-fields/section-labels", headers=headers,
        json={"order_type_code": "TH", "labels": {"bad key": "x"}},
    )
    assert resp.status_code == 422, resp.text
