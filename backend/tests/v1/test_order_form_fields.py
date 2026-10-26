"""tests/v1/test_order_form_fields：建单表单字段配置 CRUD + 护栏。

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
from app.domain.trade import OrderFormField
from app.orders import form_fields as ff
from app.orders.schemas import OrderFormFieldCreate, OrderFormFieldUpdate


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
        options=["微信", "支付宝"],
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
        options=["其他", "微信"],
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
        options=["其他", "微信"],
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
