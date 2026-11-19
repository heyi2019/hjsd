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

from app.core.errors import Validation
from app.domain.trade import OrderFormField
from app.orders import form_fields as ff
from app.orders.schemas import OrderFormFieldCreate, OrderFormFieldUpdate


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
