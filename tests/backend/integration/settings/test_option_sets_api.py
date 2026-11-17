"""MASTER-01 T20 / 选项词典（option_sets）API：只读查询 + 管理端点 + 死枚举防改。"""
from __future__ import annotations

from app.field_definitions.catalog_seed import seed_catalog

OPTION_SETS = "/api/v1/option-sets"


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
        json={"code": "INVENTORY_STATUS", "label": "库存状态", "editable": False, "options": [{"value": "IN_STOCK", "label": "在库"}]},
        headers=headers,
    )
    bad = client.put(
        f"{OPTION_SETS}/INVENTORY_STATUS",
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
            "code": "INVENTORY_STATUS",
            "label": "库存状态",
            "editable": False,
            "options": [{"value": "IN_STOCK", "label": "在库"}, {"value": "SOLD", "label": "已售"}],
        },
        headers=headers,
    )
    ok = client.put(
        f"{OPTION_SETS}/INVENTORY_STATUS",
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
            "code": "ORDER_STATUS",
            "label": "订单状态",
            "editable": False,
            "options": [{"value": "ACTIVE", "label": "进行中"}, {"value": "DONE", "label": "已完成"}],
        },
        headers=headers,
    )
    bad = client.put(
        f"{OPTION_SETS}/ORDER_STATUS",
        json={"options": [{"value": "DONE", "label": "已完成"}, {"value": "ACTIVE", "label": "进行中"}]},
        headers=headers,
    )
    assert bad.status_code == 422, bad.text


def test_dead_enum_rejects_blank_label(client, headers):
    client.post(
        OPTION_SETS,
        json={
            "code": "LEAD_STATUS",
            "label": "需求状态",
            "editable": False,
            "options": [{"value": "OPEN", "label": "未结算"}],
        },
        headers=headers,
    )
    bad = client.put(
        f"{OPTION_SETS}/LEAD_STATUS",
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
