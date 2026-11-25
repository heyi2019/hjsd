"""MASTER-01 T20 / 选项词典（option_sets）API：只读查询 + 管理端点 + 死枚举防改。"""
from __future__ import annotations

import re

from _repo import REPO_ROOT
from app.settings.field_definitions.catalog_seed import seed_catalog
from app.domain.options import OptionSet
from sqlalchemy import event, select
from app.domain.trade import OrderFormField

OPTION_SETS = "/api/option-sets"


def test_custom_dictionary_uses_existing_field_options_and_preserves_them(client, headers, db):
    from app.business.shared.form_config.form_field_admin_ops.writes import create_order_form_field

    field = create_order_form_field(
        db, order_type_code="CUSTOMER", field_key="preference", label="客户偏好", field_type="SELECT",
        options=[{"value": "", "label": "原选项"}], note="保留备注", actor="pytest",
    )
    db.commit()
    catalog = client.get("/api/custom-dictionaries", headers=headers).json()
    assert any(item["field_id"] == field.id for item in catalog["available_fields"])

    response = client.post("/api/custom-dictionaries", json={"label": "偏好字典", "field_id": field.id}, headers=headers)
    assert response.status_code == 201, response.text
    assert response.json()["field_id"] == field.id
    catalog = client.get("/api/custom-dictionaries", headers=headers).json()
    assert any(item["field_id"] == field.id and item["label"] == "偏好字典" for item in catalog["items"])
    assert all(item["field_id"] != field.id for item in catalog["available_fields"])
    registry = "/api/option-sets/CUSTOM_FIELD_DICTIONARIES"
    assert client.put(registry, json={"options": []}, headers=headers).status_code == 422
    assert client.post(f"{registry}/items", json={"label": "绕过关联"}, headers=headers).status_code == 422
    assert client.delete(registry, headers=headers).status_code == 422
    duplicate = client.post("/api/custom-dictionaries", json={"label": "另一字典", "field_id": field.id}, headers=headers)
    assert duplicate.status_code == 422

    original = [{"value": "preference_01", "label": "原选项"}]
    assert field.options == original
    changed = client.patch(f"/api/order-form-fields/{field.id}", json={"options": [*original, {"label": "新选项"}], "expected_options": original}, headers=headers)
    assert changed.status_code == 200, changed.text
    assert changed.json()["options"] == [*original, {"value": "preference_02", "label": "新选项"}]
    assert changed.json()["note"] == "保留备注"
    stale = client.patch(f"/api/order-form-fields/{field.id}", json={"options": [*original, {"label": "后写入"}], "expected_options": original}, headers=headers)
    assert stale.status_code == 409
    assert client.delete(f"/api/order-form-fields/{field.id}", headers=headers).status_code == 422
    assert client.delete(f"/api/custom-dictionaries/{field.id}", headers=headers).status_code == 204
    fields = client.get("/api/order-form-fields?order_type_code=CUSTOMER", headers=headers).json()
    assert next(item for item in fields if item["id"] == field.id)["options"] == changed.json()["options"]


def test_custom_dictionary_requires_eligible_field_and_permissions(client, headers, viewer_headers, db):
    from app.business.shared.form_config.form_field_admin_ops.writes import create_order_form_field

    catalog = client.get("/api/custom-dictionaries", headers=headers).json()
    assert catalog["available_fields"] == []
    missing = client.post("/api/custom-dictionaries", json={"label": "客户偏好"}, headers=headers)
    assert missing.status_code == 422
    denied = client.post("/api/custom-dictionaries", json={"label": "客户偏好", "field_id": 1}, headers=viewer_headers)
    assert denied.status_code == 403
    text_field = create_order_form_field(db, order_type_code="CUSTOMER", field_key="note_extra", label="备注",
                                         field_type="TEXT", actor="pytest")
    db.commit()
    invalid = client.post("/api/custom-dictionaries", json={"label": "客户偏好", "field_id": text_field.id}, headers=headers)
    assert invalid.status_code == 422


def test_dictionary_item_codes_increase_and_are_not_reused_after_deletion(client, headers):
    created = client.post(OPTION_SETS, json={"code": "TEST_SOURCE", "label": "来源"}, headers=headers)
    assert created.status_code == 201
    url = f"{OPTION_SETS}/TEST_SOURCE"
    first = client.post(f"{url}/items", json={"label": "微博"}, headers=headers)
    assert first.status_code == 201, first.text
    assert first.json()["options"] == [{"value": "test_source_01", "label": "微博"}]

    assert client.put(url, json={"options": []}, headers=headers).status_code == 200
    second = client.post(f"{url}/items", json={"label": "闲鱼"}, headers=headers)
    assert second.status_code == 201, second.text
    assert second.json()["options"] == [{"value": "test_source_02", "label": "闲鱼"}]


def test_removed_dictionary_item_keeps_its_historical_label(client, headers, db):
    from app.settings.lists.services.labels import option_labels_by_code
    assert client.post(OPTION_SETS, json={"code": "TEST_ARCHIVE", "label": "来源"}, headers=headers).status_code == 201
    url = f"{OPTION_SETS}/TEST_ARCHIVE"
    assert client.post(f"{url}/items", json={"label": "微博"}, headers=headers).status_code == 201
    assert client.put(url, json={"options": []}, headers=headers).status_code == 200
    assert option_labels_by_code(db, ["TEST_ARCHIVE"])["TEST_ARCHIVE"]["test_archive_01"] == "微博"


def test_boolean_dictionary_labels_use_yes_no_values(client, headers):
    assert client.post(OPTION_SETS, json={"code": "TEST_YES_NO", "label": "是否"}, headers=headers).status_code == 201
    url = f"{OPTION_SETS}/TEST_YES_NO/items"
    assert client.post(url, json={"label": "是"}, headers=headers).json()["options"] == [{"value": "Y", "label": "是"}]
    assert client.post(url, json={"label": "否"}, headers=headers).json()["options"][-1] == {"value": "N", "label": "否"}
    assert client.post(url, json={"label": "有"}, headers=headers).status_code == 422


def test_special_option_keeps_its_business_meaning_when_label_changes(client, headers):
    assert client.post(OPTION_SETS, json={"code": "INTERMEDIARY_TYPE", "label": "中介类型"}, headers=headers).status_code == 201
    url = f"{OPTION_SETS}/INTERMEDIARY_TYPE"
    created = client.post(f"{url}/items", json={"label": "包赔"}, headers=headers)
    assert created.status_code == 201, created.text
    option = created.json()["options"][0]
    assert option["value"] == "intermediary_type_01"
    assert option["behavior"] == "COMPENSATION"
    option["label"] = "保障交易"
    saved = client.put(url, json={"options": [option]}, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["options"][0]["behavior"] == "COMPENSATION"
    changed_code = {**option, "value": "intermediary_type_99"}
    assert client.put(url, json={"options": [changed_code]}, headers=headers).status_code == 422
    missing_behavior = {"value": option["value"], "label": option["label"]}
    assert client.put(url, json={"options": [missing_behavior]}, headers=headers).status_code == 422


def test_seeded_customer_and_yes_no_options_use_codes(seeded_db):
    seed_catalog(seeded_db, actor="pytest")
    fields = list(seeded_db.scalars(select(OrderFormField).where(
        OrderFormField.order_type_code.in_(["CUSTOMER", "HS"]),
        OrderFormField.field_key.in_(["credit_level", "recovery_record", "has_secondary", "wallet_realname"]),
    )))
    by_key = {field.field_key: field.options for field in fields}
    assert by_key["credit_level"][0] == {"value": "credit_level_01", "label": "优质"}
    assert by_key["recovery_record"][0] == {"value": "N", "label": "无"}
    assert by_key["has_secondary"] == [{"value": "Y", "label": "有"}, {"value": "N", "label": "无"}]
    assert by_key["wallet_realname"] == [{"value": "N", "label": "未注销"}, {"value": "Y", "label": "已注销"}]


def test_example_dictionary_seed_has_codes_and_special_behavior(seeded_db):
    from scripts.test_example_seed import seed_example_catalog
    seed_catalog(seeded_db, actor="pytest")
    seed_example_catalog(seeded_db)
    source = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "CUSTOMER_SOURCE"))
    platform = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "INTERMEDIARY_PLATFORM"))
    intermediary = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "INTERMEDIARY_TYPE"))
    assert source.options[0] == {"value": "customer_source_01", "label": "自营"}
    assert source.options[-1] == {"value": "customer_source_06", "label": "其他", "behavior": "OTHER"}
    assert platform.options[-1]["behavior"] == "OTHER"
    assert intermediary.options[1] == {"value": "intermediary_type_02", "label": "包赔", "behavior": "COMPENSATION"}


def test_duplicate_option_code_returns_business_error(client, headers):
    payload = {"code": "CUSTOM_DUPLICATE", "label": "重复测试"}
    assert client.post(OPTION_SETS, json=payload, headers=headers).status_code == 201
    duplicate = client.post(OPTION_SETS, json=payload, headers=headers)
    assert duplicate.status_code == 422
    assert duplicate.json()["code"] == "DUPLICATE_CODE"


def test_builtin_enum_stays_locked_even_if_legacy_editable_flag_was_changed(seeded_client, seeded_db, headers):
    seed_catalog(seeded_db, actor="pytest")
    row = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "INVENTORY_STATUS"))
    original = [dict(item) for item in row.options]
    row.editable = True
    seeded_db.commit()
    url = f"{OPTION_SETS}/INVENTORY_STATUS"
    assert seeded_client.get(url, headers=headers).json()["editable"] is False
    assert seeded_client.put(url, json={"editable": True}, headers=headers).status_code == 422
    assert seeded_client.put(url, json={"options": [{"value": "FAKE", "label": "错误"}]}, headers=headers).status_code == 422
    assert seeded_client.delete(url, headers=headers).status_code == 422
    assert seeded_client.get(url, headers=headers).json()["options"] == original
    renamed = [dict(item) for item in original]
    renamed[0]["label"] = "已更新的显示名"
    saved = seeded_client.put(url, json={"options": renamed}, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["editable"] is False
    assert saved.json()["options"] == renamed


def test_builtin_editable_dictionaries_are_not_deletable(seeded_client, seeded_db, headers):
    seed_catalog(seeded_db, actor="pytest")
    assert seeded_client.delete(f"{OPTION_SETS}/INTERMEDIARY_PLATFORM", headers=headers).status_code == 422
    assert seeded_client.delete(f"{OPTION_SETS}/BUSINESS_OVERVIEW_REMINDERS", headers=headers).status_code == 422


def test_allocation_types_are_fixed_even_though_old_seed_marks_them_editable(seeded_client, seeded_db, headers):
    seed_catalog(seeded_db, actor="pytest")
    url = f"{OPTION_SETS}/ALLOCATION_TYPE"
    result = seeded_client.get(url, headers=headers)
    assert result.json()["editable"] is False
    assert seeded_client.put(url, json={"options": [{"value": "OTHER", "label": "其他"}]}, headers=headers).status_code == 422


def test_accounting_dictionary_uses_current_15_values_without_rewriting_legacy_on_read(seeded_client, seeded_db, headers):
    from app.domain.enums import AccountingAttribute
    from app.settings.lists.export_labels import CASHFLOW_VALUE_LABELS
    seed_catalog(seeded_db, actor="pytest")
    row = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "FUND_FLOW_ACCOUNTING_ATTRIBUTE"))
    legacy = [{"value": "ADDITIONAL_INCOME", "label": "旧附加收入"}]
    row.options = legacy
    seeded_db.commit()
    url = f"{OPTION_SETS}/FUND_FLOW_ACCOUNTING_ATTRIBUTE"
    data = seeded_client.get(url, headers=headers).json()
    assert {item["value"] for item in data["options"]} == set(AccountingAttribute.values())
    assert {item["value"]: item["label"] for item in data["options"]} == CASHFLOW_VALUE_LABELS["accounting_attribute"]
    seeded_db.refresh(row)
    assert row.options == legacy
    changed = [dict(item) for item in data["options"]]
    changed[0]["label"] = "不一致的名称"
    assert seeded_client.put(url, json={"options": changed}, headers=headers).status_code == 422


def test_accounting_dictionary_labels_follow_frontend_authoritative_labels():
    from app.settings.field_definitions.catalog_seed import accounting_attribute_options
    source = (REPO_ROOT / "frontend/src/shared/lib/labels.ts").read_text(encoding="utf-8")
    match = re.search(r"export const ACCOUNTING_ATTRIBUTE_LABEL[^=]*=\s*\{(.*?)\};", source, re.S)
    assert match is not None
    labels = dict(re.findall(r'^\s*(\w+):\s*"([^"]+)"', match.group(1), re.M))
    assert {item["value"]: item["label"] for item in accounting_attribute_options()} == labels


def test_missing_builtin_enum_cannot_be_recreated_with_arbitrary_values(client, headers):
    response = client.post(OPTION_SETS, json={"code": "ORDER_STATUS", "label": "订单状态", "options": [{"value": "FAKE", "label": "错误"}]}, headers=headers)
    assert response.status_code == 422


def test_seed_catalog_batches_lookups_and_preserves_existing_configuration(seeded_db):
    seed_catalog(seeded_db, actor="pytest")
    dictionary = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "CUSTOMER_SOURCE"))
    field = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "LEAD", OrderFormField.field_key == "target"))
    source_field = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "HS", OrderFormField.field_key == "customer_source"))
    dictionary.label = "管理员名称"
    dictionary.options = [{"value": "user_source", "label": "自定义来源"}]
    source_field.options = [{"value": "user_source", "label": "自定义来源"}]
    field.label = "管理员目标名称"
    seeded_db.flush()
    queries = []
    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        sql = statement.lower()
        if sql.lstrip().startswith("select") and ("from option_sets" in sql or "from order_form_fields" in sql):
            queries.append(sql)
    connection = seeded_db.connection()
    event.listen(connection, "before_cursor_execute", capture)
    try:
        seed_catalog(seeded_db, actor="pytest")
    finally:
        event.remove(connection, "before_cursor_execute", capture)
    assert len(queries) <= 6, f"配置种子查询次数过多: {len(queries)}"
    assert dictionary.label == "管理员名称" and field.label == "管理员目标名称"
    assert dictionary.options == [{"value": "user_source", "label": "自定义来源"}]
    assert source_field.options == [{"value": "user_source", "label": "自定义来源"}]


def test_business_reminder_rejects_invalid_inventory_aging_days(client, headers):
    url = f"{OPTION_SETS}/BUSINESS_OVERVIEW_REMINDERS"
    options = [{"value": "inventory_aging_days", "label": "365"}]
    invalid = [{"value": "inventory_aging_days", "label": "366"}]
    assert client.post(OPTION_SETS, json={"code": "BUSINESS_OVERVIEW_REMINDERS", "label": "业务提醒", "options": invalid}, headers=headers).status_code == 422
    response = client.post(OPTION_SETS, json={"code": "BUSINESS_OVERVIEW_REMINDERS", "label": "业务提醒", "options": options}, headers=headers)
    assert response.status_code == 201, response.text

    for value in ("0", "366", "1e2", "1.0", "+14", " 14 ", "1\n", "１４", "9" * 5000):
        response = client.put(url, json={"options": [{"value": "inventory_aging_days", "label": value}]}, headers=headers)
        assert response.status_code == 422, value
        assert client.get(url, headers=headers).json()["options"] == options

    response = client.put(url, json={"options": [{"value": "inventory_aging_days", "label": "1"}]}, headers=headers)
    assert response.status_code == 200, response.text
    response = client.put(url, json={"options": [{"value": "inventory_aging_days", "label": "0" * 5000 + "1"}]}, headers=headers)
    assert response.status_code == 200, response.text


def test_business_reminder_configuration_rejects_invalid_switches(client, headers):
    url = f"{OPTION_SETS}/BUSINESS_OVERVIEW_REMINDERS"
    valid = [
        {"value": "inventory_aging_days", "label": "7"},
        {"value": "profit_notifications_enabled", "label": "1"},
        {"value": "overdue_installments_enabled", "label": "0"},
    ]
    invalid = [dict(item) for item in valid]
    invalid[1]["label"] = "false"
    payload = {"code": "BUSINESS_OVERVIEW_REMINDERS", "label": "业务提醒", "options": invalid}
    assert client.post(OPTION_SETS, json=payload, headers=headers).status_code == 422
    payload["options"] = valid
    created = client.post(OPTION_SETS, json=payload, headers=headers)
    assert created.status_code == 201, created.text

    for index in (1, 2):
        for bad in ("false", "true", "2", " "):
            invalid = [dict(item) for item in valid]
            invalid[index]["label"] = bad
            response = client.put(url, json={"options": invalid}, headers=headers)
            assert response.status_code == 422, response.text
            assert client.get(url, headers=headers).json()["options"] == valid

    valid[1]["label"] = "0"
    valid[2]["label"] = "1"
    saved = client.put(url, json={"options": valid}, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["options"] == valid


def test_list_empty_initially(client, headers):
    body = client.get(OPTION_SETS, headers=headers).json()
    assert body["items"] == []


def test_seeded_order_event_dictionary_excludes_retired_cost(seeded_client, seeded_db, headers):
    seed_catalog(seeded_db, actor="pytest")
    seeded_db.commit()
    body = seeded_client.get(OPTION_SETS, headers=headers).json()
    event_types = next(item for item in body["items"] if item["code"] == "ORDER_EVENT_TYPE")
    assert [item["value"] for item in event_types["options"]] == [
        "BUY",
        "SELL",
        "DELIVER",
        "CANCEL",
        "OPERATE",
        "REBATE",
    ]
    period = next(item for item in body["items"] if item["code"] == "BUSINESS_PERIOD")
    assert period["options"] == [{"value": "start_day", "label": "16"}]
    for bad in ("0", "32", "abc", "1.5"):
        response = seeded_client.put(f"{OPTION_SETS}/BUSINESS_PERIOD", json={"options": [{"value": "start_day", "label": bad}]}, headers=headers)
        assert response.status_code == 422
    response = seeded_client.put(f"{OPTION_SETS}/BUSINESS_PERIOD", json={"options": [{"value": "start_day", "label": "10"}]}, headers=headers)
    assert response.status_code == 200
    assert seeded_client.delete(f"{OPTION_SETS}/BUSINESS_PERIOD", headers=headers).status_code == 422


def test_read_requires_login(client):
    """2026-10-27 鉴权缺口回归守卫：读端点此前误用裸函数默认值，匿名可读（200）。"""
    assert client.get(OPTION_SETS).status_code == 401


def test_create_and_list_editable_set(client, headers):
    created = client.post(
        OPTION_SETS,
        json={
            "code": "GAME_TAG",
            "label": "游戏标签",
            "group": "INVENTORY",
            "editable": True,
            "options": [
                {"value": "HOT", "label": "热门"},
                {"value": "NEW", "label": "新游"},
            ],
            "description": "可自由增删的标签字典",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["code"] == "GAME_TAG"
    assert body["editable"] is True
    assert [o["value"] for o in body["options"]] == ["HOT", "NEW"]

    listed = client.get(OPTION_SETS, headers=headers).json()
    codes = {item["code"] for item in listed["items"]}
    assert "GAME_TAG" in codes


def test_filter_by_group_and_editable(client, headers):
    client.post(OPTION_SETS, json={"code": "A1", "label": "A1", "group": "G1", "editable": True}, headers=headers)
    client.post(OPTION_SETS, json={"code": "B1", "label": "B1", "group": "G2", "editable": False}, headers=headers)

    only_editable = client.get(f"{OPTION_SETS}?editable=true", headers=headers).json()
    assert {i["code"] for i in only_editable["items"]} == {"A1"}

    only_g2 = client.get(f"{OPTION_SETS}?group=G2", headers=headers).json()
    assert {i["code"] for i in only_g2["items"]} == {"B1"}


def test_update_options_on_editable_set(client, headers):
    client.post(
        OPTION_SETS,
        json={"code": "GAME_TAG", "label": "游戏标签", "editable": True, "options": [{"value": "HOT", "label": "热门"}]},
        headers=headers,
    )
    updated = client.put(
        f"{OPTION_SETS}/GAME_TAG",
        json={"options": [{"value": "HOT", "label": "热门"}, {"value": "CLASSIC", "label": "经典"}]},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert [o["value"] for o in updated.json()["options"]] == ["HOT", "CLASSIC"]



def test_dead_enum_rejects_option_change(client, headers):
    client.post(
        OPTION_SETS,
        json={"code": "CUSTOM_FIXED", "label": "库存状态", "editable": False, "options": [{"value": "IN_STOCK", "label": "在库"}]},
        headers=headers,
    )
    bad = client.put(
        f"{OPTION_SETS}/CUSTOM_FIXED",
        json={"options": [{"value": "X", "label": "越权值"}]},
        headers=headers,
    )
    assert bad.status_code == 422, bad.text
    assert bad.json()["code"] in ("VALIDATION_ERROR",)


def test_dead_enum_allows_label_only_change(client, headers):
    """2026-10-26 裁决：死枚举的值集合锁死，但展示文案可在设置页维护。

    不放开的话 47 项词典里只有 2 项纯字典能改文案，「改文案 → 全站表格同步」形同虚设。
    """
    client.post(
        OPTION_SETS,
        json={
            "code": "CUSTOM_FIXED",
            "label": "库存状态",
            "editable": False,
            "options": [{"value": "IN_STOCK", "label": "在库"}, {"value": "SOLD", "label": "已售"}],
        },
        headers=headers,
    )
    ok = client.put(
        f"{OPTION_SETS}/CUSTOM_FIXED",
        json={"options": [{"value": "IN_STOCK", "label": "在库中"}, {"value": "SOLD", "label": "已售出"}]},
        headers=headers,
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert [o["value"] for o in body["options"]] == ["IN_STOCK", "SOLD"]
    assert [o["label"] for o in body["options"]] == ["在库中", "已售出"]


def test_dead_enum_rejects_reorder(client, headers):
    """值集合相同但顺序变化也要拒绝：顺序承载展示优先级，改动同样属语义漂移。"""
    client.post(
        OPTION_SETS,
        json={
            "code": "CUSTOM_FIXED",
            "label": "订单状态",
            "editable": False,
            "options": [{"value": "ACTIVE", "label": "进行中"}, {"value": "DONE", "label": "已完成"}],
        },
        headers=headers,
    )
    bad = client.put(
        f"{OPTION_SETS}/CUSTOM_FIXED",
        json={"options": [{"value": "DONE", "label": "已完成"}, {"value": "ACTIVE", "label": "进行中"}]},
        headers=headers,
    )
    assert bad.status_code == 422, bad.text


def test_dead_enum_rejects_blank_label(client, headers):
    client.post(
        OPTION_SETS,
        json={
            "code": "CUSTOM_FIXED",
            "label": "需求状态",
            "editable": False,
            "options": [{"value": "OPEN", "label": "未结算"}],
        },
        headers=headers,
    )
    bad = client.put(
        f"{OPTION_SETS}/CUSTOM_FIXED",
        json={"options": [{"value": "OPEN", "label": "   "}]},
        headers=headers,
    )
    assert bad.status_code == 422, bad.text


def test_get_missing_returns_404(client, headers):
    assert client.get(f"{OPTION_SETS}/NOPE", headers=headers).status_code == 404


def test_delete_set(client, headers):
    client.post(OPTION_SETS, json={"code": "TMP", "label": "临时"}, headers=headers)
    deleted = client.delete(f"{OPTION_SETS}/TMP", headers=headers)
    assert deleted.status_code == 204
    assert client.get(f"{OPTION_SETS}/TMP", headers=headers).status_code == 404


def test_viewer_cannot_create(client, viewer_headers):
    resp = client.post(OPTION_SETS, json={"code": "X", "label": "X"}, headers=viewer_headers)
    assert resp.status_code == 403
