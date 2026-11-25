"""MASTER-01 游戏类型标准主数据：Service 与 HTTP 契约测试。

补齐 `app/field_definitions/game_types.py`（原 app/foundation/game_types.py，
64%→100%）与对应 router 中 game-types 一整段未被 HTTP 层覆盖的端点。既有 `test_game_types.py` 只调 service，
本文件补两端点契约 + service 的更新/停用/默认值/404 分支。
"""
from __future__ import annotations

import pytest

from app.core.errors import NotFound, Validation
from app.settings.field_definitions.game_types import (
    create_game_type,
    list_game_types,
    set_game_type_active,
    set_game_type_default,
    update_game_type,
)
from app.settings.field_definitions.game_types import _get_game_type_or_404


class TestGameTypeService:
    def test_list_excludes_inactive_when_requested(self, seeded_db):
        created = create_game_type(seeded_db, name="临时停用类型", actor="pytest")
        seeded_db.commit()
        set_game_type_active(seeded_db, created.id, False, actor="pytest")
        seeded_db.commit()
        all_items = list_game_types(seeded_db)
        active_only = list_game_types(seeded_db, include_inactive=False)
        assert created.id in [it.id for it in all_items]
        assert created.id not in [it.id for it in active_only]
        assert all(item.is_active for item in active_only)

    def test_get_game_type_or_404_raises(self, seeded_db):
        with pytest.raises(NotFound):
            _get_game_type_or_404(seeded_db, 999999)

    def test_update_game_type_applies_fields(self, seeded_db):
        created = create_game_type(seeded_db, name="测试类型A", actor="pytest")
        seeded_db.commit()
        updated = update_game_type(
            seeded_db, created.id, actor="pytest", name="测试类型A改", sort_order=7
        )
        assert updated.name == "测试类型A改"
        assert updated.sort_order == 7

    def test_update_game_type_rejects_duplicate_name(self, seeded_db):
        created = create_game_type(seeded_db, name="重名类型", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Validation, match="游戏类型已存在"):
            update_game_type(seeded_db, created.id, actor="pytest", name="王者荣耀")

    def test_set_game_type_active_success(self, seeded_db):
        created = create_game_type(seeded_db, name="测试类型B", actor="pytest")
        seeded_db.commit()
        updated = set_game_type_active(seeded_db, created.id, False, actor="pytest")
        assert updated.is_active is False

    def test_cannot_set_inactive_as_default(self, seeded_db):
        created = create_game_type(seeded_db, name="测试类型C", actor="pytest")
        seeded_db.commit()
        set_game_type_active(seeded_db, created.id, False, actor="pytest")
        seeded_db.commit()
        with pytest.raises(Validation, match="停用的游戏类型不能设为默认"):
            set_game_type_default(seeded_db, created.id, True, actor="pytest")


class TestGameTypeApi:
    def test_game_and_channel_codes_stay_stable_when_labels_change(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/game-types",
            json={"name": "新游戏", "channel_regions": [{"label": "安卓区"}]},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["value"] == f"game_{body['id']:02d}"
        assert body["channel_regions"] == [{"value": "channel_01", "label": "安卓区"}]

        edited = seeded_client.patch(
            f"/api/game-types/{body['id']}",
            json={"name": "新游戏改名", "channel_regions": [{"value": "channel_01", "label": "安卓新版"}]},
            headers=headers,
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["value"] == body["value"]
        assert edited.json()["channel_regions"] == [{"value": "channel_01", "label": "安卓新版"}]

        added = seeded_client.patch(
            f"/api/game-types/{body['id']}",
            json={"channel_regions": [{"label": "iOS"}]}, headers=headers,
        )
        assert added.status_code == 200, added.text
        assert added.json()["channel_regions"] == [{"value": "channel_02", "label": "iOS"}]

    @staticmethod
    def _non_default_id(client, headers: dict) -> int:
        resp = client.get("/api/game-types", headers=headers)
        assert resp.status_code == 200, resp.text
        target = next(it for it in resp.json() if not it["is_default"])
        return target["id"]

    @staticmethod
    def _first_id(client, headers: dict) -> int:
        resp = client.get("/api/game-types", headers=headers)
        assert resp.status_code == 200, resp.text
        return resp.json()[0]["id"]

    def test_list_game_types_endpoint(self, seeded_client, headers):
        resp = seeded_client.get(
            "/api/game-types", params={"include_inactive": "false"}, headers=headers
        )
        assert resp.status_code == 200, resp.text
        assert all(item["is_active"] for item in resp.json())

    def test_create_game_type_endpoint(self, seeded_client, headers):
        resp = seeded_client.post(
            "/api/game-types",
            json={"name": "接口新增类型", "sort_order": 3, "is_default": False},
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["name"] == "接口新增类型"

    def test_update_game_type_endpoint(self, seeded_client, headers):
        gid = self._first_id(seeded_client, headers)
        resp = seeded_client.patch(
            f"/api/game-types/{gid}",
            json={"name": "接口改名", "sort_order": 11},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "接口改名"

    def test_set_game_type_active_endpoint(self, seeded_client, headers):
        gid = self._non_default_id(seeded_client, headers)
        resp = seeded_client.patch(
            f"/api/game-types/{gid}/active",
            params={"active": "false"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["is_active"] is False

    def test_set_game_type_default_endpoint(self, seeded_client, headers):
        gid = self._first_id(seeded_client, headers)
        resp = seeded_client.patch(
            f"/api/game-types/{gid}/default",
            params={"is_default": "true"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["is_default"] is True

    def test_delete_game_type_endpoint(self, seeded_client, headers):
        gid = self._non_default_id(seeded_client, headers)
        resp = seeded_client.delete(f"/api/game-types/{gid}", headers=headers)
        assert resp.status_code == 204, resp.text

        remaining = seeded_client.get(
            "/api/game-types", params={"include_inactive": "true"}, headers=headers
        )
        assert remaining.status_code == 200, remaining.text
        assert gid not in {item["id"] for item in remaining.json()}

    def test_game_type_404_returns_not_found(self, seeded_client, headers):
        resp = seeded_client.patch(
            "/api/game-types/999999/active",
            params={"active": "false"},
            headers=headers,
        )
        assert resp.status_code == 404, resp.text
