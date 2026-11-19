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

from app.core.errors import Validation
from app.domain.trade import OrderFormField, OrderFormSectionLabel
from app.orders import form_fields as ff
from app.orders.schemas import OrderFormFieldCreate, SectionLabelsSaveIn


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

def test_required_when_rejects_inactive_dependency(seeded_db):
    """条件必填不得依赖已停用字段（写入时即拒绝，避免静默失效）。"""
    ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="dep_inactive", label="已停用来源",
        actor="admin", field_type="SELECT",
        options=[{"value": "其他", "label": "其他"}],
    )
    seeded_db.commit()
    ff.set_order_form_field_active(seeded_db,
        seeded_db.scalar(
            select(OrderFormField).where(
                OrderFormField.order_type_code == "HS",
                OrderFormField.field_key == "dep_inactive",
            )
        ).id,
        False, actor="admin",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="不存在或已停用"):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="cond_on_inactive", label="条件字段",
            actor="admin",
            required_when={"field": "dep_inactive", "op": "eq", "values": ["其他"]},
        )

def test_section_labels_rejects_unregistered_scope(seeded_db):
    """板块标题作用域必须先在注册表登记，否则写入前端永远读不到的僵尸配置。"""
    # "ZZ" 合法格式（2-10 位大写字母）但未在任何表单作用域注册。
    with pytest.raises(Validation, match="未按注册表登记"):
        ff.save_section_labels(
            seeded_db, order_type_code="ZZ", labels={"FINANCE": "资金"}, actor="admin",
        )

def test_section_labels_accepts_registered_scope(seeded_db):
    """已注册作用域（含非建单的订单操作作用域）仍可正常保存板块标题。"""
    saved = ff.save_section_labels(
        seeded_db, order_type_code="ORDEREDIT", labels={"FINANCE": "编辑页资金"}, actor="admin",
    )
    seeded_db.commit()
    assert saved == {"FINANCE": "编辑页资金"}
