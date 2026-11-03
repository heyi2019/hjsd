"""LIST-01 列表字段「新增自定义列」（迁移 0053）：候选字段、新增/删除、显示配置联动、审计。

口径：
- 候选 = 启用中的表单自定义字段（is_custom=1 & is_active=1） + 数据中已有值的键；
- 列键统一 `extra:{field_key}`，与注册表内置列隔离；
- 显示状态复用 list_column_configs：新增的列可隐藏/排序/列宽/固定；
- 恢复默认只清显示配置行，不删自定义列定义；删除必须显式 DELETE /custom/{key}。
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.domain.trade import Order, OrderFormField
from app.lists import service


def _seed_custom_field(
    db,
    *,
    field_key: str = "vip_tag",
    label: str = "VIP 标签",
    scope: str = "CUSTOMER",
    field_type: str = "SELECT",
    options=None,
    is_active: bool = True,
) -> OrderFormField:
    row = OrderFormField(
        order_type_code=scope,
        field_key=field_key,
        label=label,
        field_type=field_type,
        options=options
        if options is not None
        else [{"value": "A", "label": "甲"}, {"value": "B", "label": "乙"}],
        flow_direction=None,
        required=False,
        required_when=None,
        is_active=is_active,
        sort_order=0,
        locked=False,
        is_custom=True,
        section="EXTRA",
        created_by="tester",
        updated_by="tester",
    )
    db.add(row)
    db.flush()
    return row


def _columns(client, headers, scope: str = "LEDGER") -> list[dict]:
    response = client.get("/api/v1/list-columns", headers=headers)
    assert response.status_code == 200, response.text
    return next(item for item in response.json() if item["code"] == scope)["columns"]


def _audit_actions(db) -> list[str]:
    return [
        row.action
        for row in db.scalars(
            select(AuditLog).where(AuditLog.entity_type == "list_column_config")
        ).all()
    ]


def test_candidate_fields_only_active_custom(seeded_client, headers, seeded_db):
    _seed_custom_field(seeded_db, field_key="vip_tag", label="VIP 标签")
    _seed_custom_field(seeded_db, field_key="disabled_tag", label="停用", is_active=False)
    _seed_custom_field(seeded_db, field_key="level", label="等级", scope="HS", field_type="TEXT", options=[])

    response = seeded_client.get("/api/v1/list-columns/custom-fields", headers=headers)
    assert response.status_code == 200, response.text
    rows = [row for row in response.json() if not row.get("data_only")]
    assert {row["field_key"] for row in rows} == {"vip_tag", "level"}
    vip = next(row for row in rows if row["field_key"] == "vip_tag")
    assert vip["scope_label"] == "客户建档"
    assert vip["options"] == [{"value": "A", "label": "甲"}, {"value": "B", "label": "乙"}]


def test_data_only_keys_become_candidates_and_addable(seeded_client, headers, seeded_db):
    """数据里实际有值但无字段定义的键（如 qa500_note）也应能选为列。"""
    seeded_db.add(
        Order(
            order_no="HS9901",
            order_type="HS",
            capital_type="STOCK",
            trade_date=date(2026, 1, 1),
            form_extra={"qa500_note": "补齐轮回填"},
            created_by="tester",
            updated_by="tester",
        )
    )
    seeded_db.flush()

    response = seeded_client.get("/api/v1/list-columns/custom-fields", headers=headers)
    assert response.status_code == 200, response.text
    data_rows = [row for row in response.json() if row.get("data_only")]
    qa = next(row for row in data_rows if row["field_key"] == "qa500_note")
    assert qa["scope"] == "DATA"
    assert qa["label"] == "qa500_note"
    assert qa["field_type"] == "TEXT"
    assert qa["row_count"] >= 1
    assert "订单" in qa["source_label"]

    added = seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom",
        json={"field_key": "qa500_note", "label": "补齐备注"},
        headers=headers,
    )
    assert added.status_code == 200, added.text
    custom = next(c for c in added.json()["columns"] if c["key"] == "extra:qa500_note")
    assert custom["label"] == "补齐备注"
    assert custom["source_key"] == "qa500_note"
    assert custom["value_labels"] is None  # 数据键无选项快照，按原值展示

    # 未启用且数据中不存在的键仍拒绝
    unknown = seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom", json={"field_key": "no_such_field"}, headers=headers
    )
    assert unknown.status_code == 422, unknown.text


def test_data_only_key_prefers_definition_label(seeded_client, headers, seeded_db):
    """数据键若在字段定义表里有同 key 记录（哪怕停用），候选名用定义的 label。"""
    _seed_custom_field(seeded_db, field_key="legacy_note", label="历史备注", is_active=False)
    seeded_db.add(
        Order(
            order_no="HS9902",
            order_type="HS",
            capital_type="STOCK",
            trade_date=date(2026, 1, 2),
            form_extra={"legacy_note": "x"},
            created_by="tester",
            updated_by="tester",
        )
    )
    seeded_db.flush()

    response = seeded_client.get("/api/v1/list-columns/custom-fields", headers=headers)
    legacy = next(
        row for row in response.json() if row.get("data_only") and row["field_key"] == "legacy_note"
    )
    assert legacy["label"] == "历史备注"


def test_add_custom_column_appends_with_source_and_value_labels(seeded_client, headers, seeded_db):
    _seed_custom_field(seeded_db)
    response = seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom",
        json={"field_key": "vip_tag"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    columns = response.json()["columns"]
    custom = next(column for column in columns if column["key"] == "extra:vip_tag")
    assert custom["custom"] is True
    assert custom["source_key"] == "vip_tag"
    assert custom["label"] == "VIP 标签"
    assert custom["value_labels"] == {"A": "甲", "B": "乙"}
    assert custom["locked"] is False
    # 未配置时排在内置列之后
    assert columns[-1]["key"] == "extra:vip_tag"
    # 其它列表不受影响
    assert all(column["key"] != "extra:vip_tag" for column in _columns(seeded_client, headers, "INVENTORY"))


def test_add_custom_column_with_custom_label(seeded_client, headers, seeded_db):
    _seed_custom_field(seeded_db)
    response = seeded_client.post(
        "/api/v1/list-columns/CUSTOMER/custom",
        json={"field_key": "vip_tag", "label": "会员等级标签"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    custom = next(c for c in response.json()["columns"] if c["key"] == "extra:vip_tag")
    assert custom["label"] == "会员等级标签"


def test_add_custom_column_rejects_duplicate_unknown_field_and_scope(seeded_client, headers, seeded_db):
    _seed_custom_field(seeded_db)
    url = "/api/v1/list-columns/LEDGER/custom"
    assert seeded_client.post(url, json={"field_key": "vip_tag"}, headers=headers).status_code == 200
    duplicate = seeded_client.post(url, json={"field_key": "vip_tag"}, headers=headers)
    assert duplicate.status_code == 409, duplicate.text

    unknown = seeded_client.post(url, json={"field_key": "no_such_field"}, headers=headers)
    assert unknown.status_code == 422, unknown.text

    bad_scope = seeded_client.post(
        "/api/v1/list-columns/NOT_A_LIST/custom", json={"field_key": "vip_tag"}, headers=headers
    )
    assert bad_scope.status_code == 404, bad_scope.text


def test_add_custom_column_requires_permission(seeded_client, viewer_headers, seeded_db):
    _seed_custom_field(seeded_db)
    response = seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom",
        json={"field_key": "vip_tag"},
        headers=viewer_headers,
    )
    assert response.status_code == 403, response.text


def test_save_allows_custom_column_position_and_visibility(seeded_client, headers, seeded_db):
    _seed_custom_field(seeded_db)
    assert seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom", json={"field_key": "vip_tag"}, headers=headers
    ).status_code == 200
    columns = _columns(seeded_client, headers)
    # 把自定义列提到第一位并隐藏
    ordered = [next(c for c in columns if c["key"] == "extra:vip_tag"), *[c for c in columns if c["key"] != "extra:vip_tag"]]
    items = [
        {
            "column_key": column["key"],
            "is_visible": column["key"] != "extra:vip_tag",
            "sort_order": index * 10,
        }
        for index, column in enumerate(ordered)
    ]
    saved = seeded_client.put("/api/v1/list-columns/LEDGER", json={"items": items}, headers=headers)
    assert saved.status_code == 200, saved.text
    by_key = {c["key"]: c for c in saved.json()["columns"]}
    assert by_key["extra:vip_tag"]["is_visible"] is False
    assert saved.json()["columns"][0]["key"] == "extra:vip_tag"
    assert by_key["extra:vip_tag"]["custom"] is True


def test_reset_keeps_custom_column_definition(seeded_client, headers, seeded_db):
    _seed_custom_field(seeded_db)
    seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom", json={"field_key": "vip_tag"}, headers=headers
    )
    columns = _columns(seeded_client, headers)
    items = [
        {"column_key": c["key"], "is_visible": c["key"] != "extra:vip_tag", "sort_order": i * 10}
        for i, c in enumerate(columns)
    ]
    assert seeded_client.put("/api/v1/list-columns/LEDGER", json={"items": items}, headers=headers).status_code == 200

    reset = seeded_client.delete("/api/v1/list-columns/LEDGER", headers=headers)
    assert reset.status_code == 200, reset.text
    reset_columns = reset.json()["columns"]
    custom = next(c for c in reset_columns if c["key"] == "extra:vip_tag")
    assert custom["is_visible"] is True  # 显示状态回默认
    assert custom["source_key"] == "vip_tag"  # 定义保留


def test_remove_custom_column(seeded_client, headers, viewer_headers, seeded_db):
    _seed_custom_field(seeded_db)
    seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom", json={"field_key": "vip_tag"}, headers=headers
    )
    url = "/api/v1/list-columns/LEDGER/custom/extra:vip_tag"
    assert seeded_client.delete(url, headers=viewer_headers).status_code == 403

    removed = seeded_client.delete(url, headers=headers)
    assert removed.status_code == 200, removed.text
    assert all(c["key"] != "extra:vip_tag" for c in removed.json()["columns"])
    assert all(c["key"] != "extra:vip_tag" for c in _columns(seeded_client, headers))

    assert seeded_client.delete(url, headers=headers).status_code == 404


def test_custom_column_writes_audit_actions(seeded_client, headers, seeded_db):
    _seed_custom_field(seeded_db)
    seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom", json={"field_key": "vip_tag"}, headers=headers
    )
    seeded_client.delete("/api/v1/list-columns/LEDGER/custom/extra:vip_tag", headers=headers)
    actions = _audit_actions(seeded_db)
    assert AuditAction.LIST_COLUMN_ADD.value in actions
    assert AuditAction.LIST_COLUMN_REMOVE.value in actions


def test_value_labels_include_custom_column(seeded_db):
    _seed_custom_field(seeded_db)
    service.add_custom_column(
        seeded_db, "LEDGER", field_key="vip_tag", label=None, actor="tester"
    )
    labels = service.get_value_labels(seeded_db, "LEDGER")
    assert labels["extra:vip_tag"] == {"A": "甲", "B": "乙"}
