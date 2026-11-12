"""POLICY-01 policy 经营规则契约测试（T19/T20，BAS-06-01~04）。

与 test_m5_policy.py 的分工：m5 已覆盖创建/发布/解析/快照固化/分配主路径与 401 门控；
本文件补筛选参数、NotFound 分支、空参校验、`_overlaps` exclude 私有路径、
snapshot_for 无快照、set_allocations 坏 rate，以及 6 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import PolicyScopeType, PolicyStatus
from app.domain.parties import PolicyDefinition
from app.orders.create import create_order
from app.policy import definitions as policy_definitions
from app.policy import versions as policy_versions
from app.policy.profit_allocation import service as policy_allocations

D = date(2026, 10, 4)


def test_policy_routes_publish_typed_response_models(app):
    paths = app.openapi()["paths"]

    assert paths["/api/v1/policies"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/PolicyDefinitionListOut"
    )
    assert paths["/api/v1/policy-versions/resolve"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/PolicyResolveOut"
    )
    assert paths["/api/v1/orders/{order_id}/profit-allocations"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/ProfitAllocationListOut"
    )


@pytest.fixture()
def json_headers(headers):
    """带 Content-Type 的写入头（conftest 的 headers 只有身份头）。"""
    return {**headers, "Content-Type": "application/json"}


def _make_policy(seeded_db, *, code="REBATE", name="返点规则") -> dict:
    return policy_definitions.create_definition(
        seeded_db, policy_code=code, name=name, scope_type="GLOBAL",
        description="测试用规则", actor="pytest",
    )


def _publish(seeded_db, definition, *, frm, to=None, config=None, approve=True):
    version = policy_versions.create_version(
        seeded_db, definition["id"], effective_from=frm, effective_to=to,
        config=config or {"rate": "5"}, actor="pytest",
    )
    return version


# ------------------------------------------------------------------ 规则定义
class TestPolicyDefinitions:
    @pytest.mark.parametrize("scope_type", ["UNKNOWN", "ORDER", "global"])
    def test_database_rejects_invalid_scope_type(self, seeded_db, scope_type):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                PolicyDefinition.__table__.insert().values(
                    policy_code=f"BAD_{scope_type.upper()}",
                    name="非法规则",
                    scope_type=scope_type,
                    scope_id=None,
                    status=PolicyStatus.DRAFT.value,
                    created_by="pytest",
                    updated_by="pytest",
                )
            )

    def test_database_rejects_invalid_global_scope_link(self, seeded_db):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                PolicyDefinition.__table__.insert().values(
                    policy_code="BAD_GLOBAL",
                    name="非法全局规则",
                    scope_type=PolicyScopeType.GLOBAL.value,
                    scope_id=1,
                    status=PolicyStatus.DRAFT.value,
                    created_by="pytest",
                    updated_by="pytest",
                )
            )

    def test_database_rejects_unbound_scoped_policy(self, seeded_db):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                PolicyDefinition.__table__.insert().values(
                    policy_code="BAD_ORDER_TYPE",
                    name="未绑定业务规则",
                    scope_type=PolicyScopeType.ORDER_TYPE.value,
                    scope_id=None,
                    status=PolicyStatus.DRAFT.value,
                    created_by="pytest",
                    updated_by="pytest",
                )
            )

    def test_list_definitions_filters(self, seeded_db):
        rebate = _make_policy(seeded_db, code="REBATE")
        _make_policy(seeded_db, code="COMMISSION", name="提成规则")
        # 定义创建即为 DRAFT；直接把一条改成 ACTIVE 以覆盖 status 过滤
        from app.domain.parties import PolicyDefinition

        item = seeded_db.get(PolicyDefinition, rebate["id"])
        item.status = PolicyStatus.ACTIVE.value
        seeded_db.commit()

        all_items = policy_definitions.list_definitions(seeded_db)
        assert {i["policy_code"] for i in all_items} >= {"REBATE", "COMMISSION"}

        by_status = policy_definitions.list_definitions(
            seeded_db, status=PolicyStatus.ACTIVE.value
        )
        assert [i["policy_code"] for i in by_status] == ["REBATE"]

        by_code = policy_definitions.list_definitions(
            seeded_db, policy_code=PolicyStatus.ACTIVE.value and "commission"
        )
        assert [i["policy_code"] for i in by_code] == ["COMMISSION"]

    def test_get_definition_notfound(self, seeded_db):
        with pytest.raises(NotFound) as exc:
            policy_definitions.get_definition(seeded_db, 999999)
        assert "不存在" in str(exc.value)

    def test_create_definition_empty_name(self, seeded_db):
        with pytest.raises(Validation) as exc:
            policy_definitions.create_definition(
                seeded_db, policy_code="X", name="  ", scope_type="GLOBAL",
                actor="pytest",
            )
        assert "name" in str(exc.value)

    def test_definition_and_approval_text_inputs_are_business_errors(self, seeded_db):
        with pytest.raises(Validation, match="policy_code 不能为空"):
            policy_definitions.create_definition(
                seeded_db, policy_code=123, name="规则", scope_type="GLOBAL",
                actor="pytest",
            )
        with pytest.raises(Validation, match="name 不能为空"):
            policy_definitions.create_definition(
                seeded_db, policy_code="TEXT_NAME", name=123, scope_type="GLOBAL",
                actor="pytest",
            )
        with pytest.raises(Validation, match="scope_type 非法"):
            policy_definitions.create_definition(
                seeded_db, policy_code="TEXT_SCOPE", name="规则", scope_type=123,
                actor="pytest",
            )


    def test_create_definition_requires_positive_scoped_id(self, seeded_db):
        with pytest.raises(Validation) as exc:
            policy_definitions.create_definition(
                seeded_db,
                policy_code="SCOPED",
                name="范围规则",
                scope_type="ORDER_TYPE",
                scope_id=0,
                actor="pytest",
            )
        assert "scope_id" in str(exc.value)


# ------------------------------------------------------------------ 版本
class TestPolicyVersions:
    def test_resolve_inputs_are_strictly_typed(self, seeded_db):
        with pytest.raises(Validation, match="policy_code 不能为空"):
            policy_versions.resolve_version(
                seeded_db, policy_code=123, on=D
            )
        with pytest.raises(Validation, match="scope_type 非法"):
            policy_versions.resolve_version(
                seeded_db, policy_code="REBATE", on=D, scope_type=123
            )

    def test_overlaps_with_exclude_version(self, seeded_db):
        definition = _make_policy(seeded_db)
        version = _publish(seeded_db, definition, frm=date(2026, 1, 1))
        # 排除自身后不再重叠（覆盖 exclude_version_id 分支）
        assert (
            policy_versions._overlaps(
                seeded_db, definition["id"], date(2026, 6, 1), None,
                exclude_version_id=version["id"],
            )
            is None
        )
        # 不排除则命中
        assert (
            policy_versions._overlaps(
                seeded_db, definition["id"], date(2026, 6, 1), None
            )
            is not None
        )

    def test_list_versions_notfound_and_status_filter(self, seeded_db):
        with pytest.raises(NotFound):
            policy_versions.list_versions(seeded_db, 999999)

        definition = _make_policy(seeded_db)
        # 创建即发布：版本均为 ACTIVE（已删除 DRAFT 草稿态）
        v1 = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1),
            effective_to=date(2026, 12, 31), config={"rate": "5"}, actor="pytest",
        )
        v2 = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2027, 1, 1),
            config={"rate": "6"}, actor="pytest",
        )
        assert v1["status"] == PolicyStatus.ACTIVE.value
        assert v2["status"] == PolicyStatus.ACTIVE.value

        only_active = policy_versions.list_versions(
            seeded_db, definition["id"], status=PolicyStatus.ACTIVE.value
        )
        assert {v["id"] for v in only_active} == {v1["id"], v2["id"]}
        only_draft = policy_versions.list_versions(
            seeded_db, definition["id"], status=PolicyStatus.DRAFT.value
        )
        assert only_draft == []

    def test_create_version_notfound_and_empty_config(self, seeded_db):
        with pytest.raises(NotFound):
            policy_versions.create_version(
                seeded_db, 999999, effective_from=D, config={"rate": "5"},
                actor="pytest",
            )
        definition = _make_policy(seeded_db)
        with pytest.raises(Validation) as exc:
            policy_versions.create_version(
                seeded_db, definition["id"], effective_from=D, config={},
                actor="pytest",
            )
        assert "参数不能为空" in str(exc.value)
        with pytest.raises(Validation) as exc:
            policy_versions.create_version(
                seeded_db, definition["id"], effective_from=D, config=["rate"],
                actor="pytest",
            )
        assert "对象" in str(exc.value)

    def test_update_version_draft_rejects_published_version(self, seeded_db):
        with pytest.raises(NotFound):
            policy_versions.update_version_draft(
                seeded_db, 999999, config={"rate": "5"}
            )
        definition = _make_policy(seeded_db)
        version = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=D,
            config={"rate": "5"}, actor="pytest",
        )
        # 创建即发布（ACTIVE）：已发布版本不可改，只能新建版本封口
        with pytest.raises(Validation) as exc:
            policy_versions.update_version_draft(seeded_db, version["id"], config={"rate": "6"})
        assert "不可修改" in str(exc.value)


# ------------------------------------------------------------------ 快照与分配
class TestSnapshotAndAllocations:
    def test_snapshot_for_order_with_and_without_policy(self, seeded_db):
        # 无生效规则的订单：快照为 None
        plain = create_order(
            seeded_db, order_type="HS", trade_date=D, actor="pytest"
        )
        assert policy_versions.snapshot_for(seeded_db, plain.id) is None

        # 发布 REBATE 规则后再建单：快照固化
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1))
        snapshotted = create_order(
            seeded_db, order_type="HS", trade_date=D, actor="pytest"
        )
        snapshot = policy_versions.snapshot_for(seeded_db, snapshotted.id)
        assert snapshot is not None
        assert snapshot["policy_version_id"] == snapshotted.policy_version_id
        assert "REBATE" in snapshot["policy_snapshot"]

    def test_set_allocations_notfound_and_bad_rate(self, seeded_db):
        with pytest.raises(NotFound):
            policy_allocations.set_allocations(
                seeded_db, 999999,
                items=[{"user_id": 1, "role": "SALES", "allocation_rate": 100}],
                actor="pytest",
            )
        order = create_order(
            seeded_db, order_type="HS", trade_date=D, actor="pytest"
        )
        with pytest.raises(Validation) as exc:
            policy_allocations.set_allocations(
                seeded_db, order.id,
                items=[{"user_id": 1, "role": "SALES", "allocation_rate": "abc"}],
                actor="pytest",
            )
        assert "数值" in str(exc.value)


# ------------------------------------------------------------------ 路由层
class TestPolicyApi:
    """补 6 个未测端点：GET /policies、GET /policies/{id}、PATCH 版本、
    GET/PUT 利润分配、GET 规则快照。"""

    def test_list_and_get_definitions_endpoints(self, seeded_client, seeded_db, json_headers):
        definition = _make_policy(seeded_db)

        listed = seeded_client.get(
            "/api/v1/policies", params={"policy_code": "REBATE"}, headers=json_headers
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()["total"] == 1
        assert listed.json()["items"][0]["id"] == definition["id"]

        fetched = seeded_client.get(
            f"/api/v1/policies/{definition['id']}", headers=json_headers
        )
        assert fetched.status_code == 200
        assert fetched.json()["policy_code"] == "REBATE"

        missing = seeded_client.get("/api/v1/policies/999999", headers=json_headers)
        assert missing.status_code == 404

    def test_patch_version_endpoint_rejects_published(self, seeded_client, seeded_db, json_headers):
        definition = _make_policy(seeded_db)
        version = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=D,
            config={"rate": "5"}, actor="pytest",
        )
        patched = seeded_client.patch(
            f"/api/v1/policy-versions/{version['id']}",
            headers=json_headers,
            json={"config": {"rate": "7"}},
        )
        # 创建即发布（ACTIVE）：已发布版本不可改，PATCH 被拒
        assert patched.status_code in (400, 422), patched.text

    def test_profit_allocations_endpoints(self, seeded_client, seeded_db, json_headers):
        order = create_order(
            seeded_db, order_type="HS", trade_date=D, actor="pytest"
        )
        put = seeded_client.put(
            f"/api/v1/orders/{order.id}/profit-allocations",
            headers=json_headers,
            json={
                "items": [
                    {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": 0},
                    {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": 0},
                    {"allocation_type": "OPERATION", "user_id": 7, "role": "OWNER", "allocation_rate": 100},
                    {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": 0},
                ]
            },
        )
        assert put.status_code == 200, put.text
        assert put.json()["total"] == 4
        # 订单总利润随分润接口下发（弹窗展示 + 金额分润上限）。该单无过账事件 → 利润 0。
        assert Decimal(str(put.json()["order_profit"])) == 0

        listed = seeded_client.get(
            f"/api/v1/orders/{order.id}/profit-allocations", headers=json_headers
        )
        assert listed.status_code == 200
        assert Decimal(str(listed.json()["order_profit"])) == 0
        operation = next(
            item for item in listed.json()["items"] if item["allocation_type"] == "OPERATION"
        )
        assert operation["user_id"] == 7

    def test_policy_snapshot_endpoint(self, seeded_client, seeded_db, json_headers):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1))
        order = create_order(
            seeded_db, order_type="HS", trade_date=D, actor="pytest"
        )
        found = seeded_client.get(
            f"/api/v1/orders/{order.id}/policy-snapshot", headers=json_headers
        )
        assert found.status_code == 200, found.text
        assert found.json()["found"] is True
        assert found.json()["snapshot"]["policy_snapshot"]

        # 无快照订单：found=False
        plain = create_order(
            seeded_db, order_type="TH", trade_date=date(2025, 1, 1), actor="pytest"
        )
        none = seeded_client.get(
            f"/api/v1/orders/{plain.id}/policy-snapshot", headers=json_headers
        )
        assert none.status_code == 200
        assert none.json()["found"] is False
        assert none.json()["snapshot"] is None

    def test_scoped_user_cannot_read_foreign_order_policy_data(
        self, seeded_client, seeded_db
    ):
        foreign = create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="other",
            owner_id=8,
        )
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}

        allocations = seeded_client.get(
            f"/api/v1/orders/{foreign.id}/profit-allocations", headers=headers
        )
        snapshot = seeded_client.get(
            f"/api/v1/orders/{foreign.id}/policy-snapshot", headers=headers
        )

        assert allocations.status_code == 404
        assert snapshot.status_code == 404
