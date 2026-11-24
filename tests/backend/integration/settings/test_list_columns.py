"""LIST-01 列表列显示配置（迁移 0051）：作用域清单、可见性与顺序保存。

口径：
- 列清单/中文名以 `app.settings.lists.scopes` 注册表为准，库只存 is_visible + sort_order；
- 缺行即默认可见（新增列无需数据迁移）；
- 所有列均可隐藏与调序（无锁定约束）；未知列仍拒绝写入。
"""
from __future__ import annotations

from sqlalchemy import select

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.settings.lists.scopes import LIST_SCOPES, get_scope


def _registry(code: str):
    scope = get_scope(code)
    assert scope is not None
    return scope.columns


def _scope(client, headers, code: str) -> dict:
    response = client.get("/api/list-columns", headers=headers)
    assert response.status_code == 200, response.text
    return next(item for item in response.json() if item["code"] == code)


def _save(client, headers, code: str, items: list[dict]):
    return client.put(f"/api/list-columns/{code}", json={"items": items}, headers=headers)


def test_list_scopes_match_registry(seeded_client, headers):
    response = seeded_client.get("/api/list-columns", headers=headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert {item["code"] for item in payload} == {scope.code for scope in LIST_SCOPES}
    ledger = next(item for item in payload if item["code"] == "LEDGER")
    assert [column["key"] for column in ledger["columns"][:2]] == ["stock_no", "order_no"]
    assert next(column for column in ledger["columns"] if column["key"] == "account_status")["label"] == "库存状态"
    # 缺行默认可见（不播种也能用）
    assert all(column["is_visible"] for column in ledger["columns"])
    assert ledger["columns"][0]["locked"] is False


def test_cashflow_settings_only_offer_columns_present_on_page(seeded_client, headers):
    columns = _scope(seeded_client, headers, "CASHFLOW")["columns"]
    keys = {column["key"] for column in columns}
    assert "pool_name" in keys
    assert "actions" not in keys


def test_rebate_page_column_changes_preserve_legacy_export_configuration(seeded_client, headers):
    legacy = _scope(seeded_client, headers, "REBATE")
    saved = _save(seeded_client, headers, "REBATE", [
        {"column_key": column["key"], "is_visible": column["key"] != "amount", "sort_order": index * 10}
        for index, column in enumerate(legacy["columns"])
    ])
    assert saved.status_code == 200, saved.text
    export_columns = _scope(seeded_client, headers, "REBATE")["columns"]

    page = _scope(seeded_client, headers, "REBATE_DETAIL")
    saved = _save(seeded_client, headers, "REBATE_DETAIL", [
        {"column_key": column["key"], "is_visible": column["key"] != "operator", "sort_order": index * 10}
        for index, column in enumerate(page["columns"])
    ])
    assert saved.status_code == 200, saved.text
    assert _scope(seeded_client, headers, "REBATE")["columns"] == export_columns
    assert next(column for column in _scope(seeded_client, headers, "REBATE_DETAIL")["columns"] if column["key"] == "operator")["is_visible"] is False


def test_save_hides_column_and_reorders(seeded_client, headers, seeded_db):
    ledger = _scope(seeded_client, headers, "LEDGER")
    columns = ledger["columns"]
    # 关掉「库存状态」列，并把「入库时间」提到第一位，其余保持相对顺序
    rest = [column for column in columns if column["key"] not in {"account_status", "inventory_entry_at"}]
    inventory_entry_at = next(column for column in columns if column["key"] == "inventory_entry_at")
    hidden = next(column for column in columns if column["key"] == "account_status")
    ordered = [inventory_entry_at, *rest, hidden]
    items = [
        {
            "column_key": column["key"],
            "is_visible": False if column["key"] == "account_status" else column["is_visible"],
            "sort_order": index * 10,
        }
        for index, column in enumerate(ordered)
    ]

    response = _save(seeded_client, headers, "LEDGER", items)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert [column["key"] for column in saved["columns"]][0] == "inventory_entry_at"
    by_key = {column["key"]: column for column in saved["columns"]}
    # 隐藏列仍出现在清单里（设置页要能重新打开），只是 is_visible=False
    assert by_key["account_status"]["is_visible"] is False

    # 再次读取：顺序与隐藏态已持久化
    reloaded = _scope(seeded_client, headers, "LEDGER")
    assert reloaded["columns"][0]["key"] == "inventory_entry_at"
    assert {column["key"]: column for column in reloaded["columns"]}["account_status"]["is_visible"] is False

    actions = [
        row.action
        for row in seeded_db.scalars(
            select(AuditLog).where(AuditLog.entity_type == "list_column_config")
        ).all()
    ]
    assert AuditAction.LIST_COLUMNS_UPDATE.value in actions


def test_actions_column_can_be_hidden(seeded_client, headers):
    """操作列现在也可隐藏（无锁定约束），保存返回 200。"""
    ledger = _scope(seeded_client, headers, "LEDGER")
    items = [
        {
            "column_key": column["key"],
            "is_visible": False if column["key"] == "actions" else column["is_visible"],
            "sort_order": index * 10,
        }
        for index, column in enumerate(ledger["columns"])
    ]
    response = _save(seeded_client, headers, "LEDGER", items)
    assert response.status_code == 200, response.text


def test_unknown_column_rejected(seeded_client, headers):
    response = _save(
        seeded_client,
        headers,
        "LEDGER",
        [{"column_key": "not_a_column", "is_visible": True, "sort_order": 0}],
    )
    assert response.status_code == 422, response.text
    assert "列不属于该列表" in response.text


def test_unknown_scope_rejected(seeded_client, headers):
    response = _save(
        seeded_client, headers, "NOT_A_LIST", [{"column_key": "order_no", "is_visible": True, "sort_order": 0}]
    )
    assert response.status_code == 404, response.text


def test_write_requires_permission(seeded_client, viewer_headers):
    response = _save(
        seeded_client,
        viewer_headers,
        "LEDGER",
        [{"column_key": "order_no", "is_visible": True, "sort_order": 0}],
    )
    assert response.status_code == 403, response.text


def test_save_fixed(seeded_client, headers):
    """固定列保存后持久化；显式传 null 表示取消固定。"""
    ledger = _scope(seeded_client, headers, "LEDGER")
    items = [
        {
            "column_key": column["key"],
            "is_visible": column["is_visible"],
            "sort_order": index * 10,
            "fixed": "left" if column["key"] == "order_no" else None,
        }
        for index, column in enumerate(ledger["columns"])
    ]
    response = _save(seeded_client, headers, "LEDGER", items)
    assert response.status_code == 200, response.text
    by_key = {column["key"]: column for column in response.json()["columns"]}
    assert by_key["order_no"]["fixed"] == "left"

    reloaded = {column["key"]: column for column in _scope(seeded_client, headers, "LEDGER")["columns"]}
    assert reloaded["order_no"]["fixed"] == "left"

    # 取消覆盖：传 null 后回到默认
    next(item for item in items if item["column_key"] == "order_no")["fixed"] = None
    cleared = _save(seeded_client, headers, "LEDGER", items)
    assert cleared.status_code == 200, cleared.text
    cleared_by_key = {column["key"]: column for column in cleared.json()["columns"]}
    assert cleared_by_key["order_no"]["fixed"] is None


def test_invalid_fixed_rejected(seeded_client, headers):
    """非法固定值由后端拒绝。"""
    base = {"column_key": "order_no", "is_visible": True, "sort_order": 0}
    bad_fixed = _save(seeded_client, headers, "LEDGER", [{**base, "fixed": "center"}])
    assert bad_fixed.status_code == 422, bad_fixed.text


def test_reset_restores_registry_default(seeded_client, headers, seeded_db):
    """恢复默认：清空配置行 → 回到注册表顺序 + 全列可见，并写 RESET 审计。"""
    ledger = _scope(seeded_client, headers, "LEDGER")
    items = [
        {
            "column_key": column["key"],
            "is_visible": False if column["key"] == "status" else column["is_visible"],
            "sort_order": index * 10,
        }
        for index, column in enumerate(reversed(ledger["columns"]))
    ]
    assert _save(seeded_client, headers, "LEDGER", items).status_code == 200
    assert _scope(seeded_client, headers, "LEDGER")["columns"][0]["key"] == "actions"

    response = seeded_client.delete("/api/list-columns/LEDGER", headers=headers)
    assert response.status_code == 200, response.text
    reset = response.json()
    assert [column["key"] for column in reset["columns"]] == [column.key for column in _registry("LEDGER")]
    assert all(column["is_visible"] for column in reset["columns"])
    assert all(column["fixed"] is None for column in reset["columns"])

    actions = [
        row.action
        for row in seeded_db.scalars(
            select(AuditLog).where(AuditLog.entity_type == "list_column_config")
        ).all()
    ]
    assert AuditAction.LIST_COLUMNS_RESET.value in actions

    # 幂等：已无配置时再重置也成功，且不再产生审计
    again = seeded_client.delete("/api/list-columns/LEDGER", headers=headers)
    assert again.status_code == 200, again.text
    assert again.json()["columns"] == reset["columns"]


def test_reset_unknown_scope_and_permission(seeded_client, headers, viewer_headers):
    assert seeded_client.delete("/api/list-columns/NOT_A_LIST", headers=headers).status_code == 404
    assert seeded_client.delete("/api/list-columns/LEDGER", headers=viewer_headers).status_code == 403
