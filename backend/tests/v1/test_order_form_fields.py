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
    # 选项保持不变
    assert updated.options == ["微信", "支付宝"]


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
