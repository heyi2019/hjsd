"""POLICY-01 T19 / T20：经营规则版本化与快照固化（BAS-06-01~04）。

核心红线（BAS-06-04）：
> 改未来费率不会改写已发生订单的利润
"""
from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy.exc import IntegrityError

from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import PolicyStatus, PolicyType
from app.domain.parties import PolicyVersion
from app.domain.trade import OrderEvent, OrderProfitAllocation
from app.orders.create import create_order
from app.orders.events import post_event
from app.policy.profit_allocation import service as policy_allocations
from app.policy.profit_allocation.listing import list_allocations
from app.policy import definitions as policy_definitions
from app.policy import versions as policy_versions



def _make_policy(seeded_db, *, code="COMMISSION", name="分润规则") -> dict:
    return policy_definitions.create_definition(
        seeded_db,
        policy_code=code,
        name=name,
        scope_type="GLOBAL",
        description="测试用规则",
        actor="pytest",
    )

def _publish(seeded_db, definition, *, frm, to=None, config, approve=True):
    version = policy_versions.create_version(
        seeded_db,
        definition["id"],
        effective_from=frm,
        effective_to=to,
        config=config,
        actor="pytest",
    )
    return version

@pytest.fixture()
def json_headers(headers):
    """带 Content-Type 的写入头（默认 headers fixture 只有身份头）。"""
    return {**headers, "Content-Type": "application/json"}

@pytest.fixture()
def viewer_json_headers(viewer_headers):
    return {**viewer_headers, "Content-Type": "application/json"}

class TestPolicyApi:
    """路由层：权限门控与响应结构。"""

    def test_endpoints_require_login(self, seeded_client):
        assert seeded_client.get("/api/v1/policies").status_code == 401

    def test_policy_requests_reject_unknown_fields(self, seeded_client, json_headers):
        response = seeded_client.post(
            "/api/v1/policies",
            headers=json_headers,
            json={
                "policy_code": "REBATE",
                "name": "返点规则",
                "scope_type": "GLOBAL",
                "legacy_field": "must not be ignored",
            },
        )
        assert response.status_code == 422
        assert response.json()["code"] == "VALIDATION_ERROR"

    def test_list_and_create_flow(self, seeded_client, json_headers):
        created = seeded_client.post(
            "/api/v1/policies",
            headers=json_headers,
            json={"policy_code": "REBATE", "name": "返点规则", "scope_type": "GLOBAL"},
        )
        assert created.status_code == 200
        definition_id = created.json()["id"]

        version = seeded_client.post(
            f"/api/v1/policies/{definition_id}/versions",
            headers=json_headers,
            json={"effective_from": "2026-01-01", "config": {"rate": "5"}},
        )
        assert version.status_code == 200
        # 保存即发布：新建版本直接为 ACTIVE，无独立审批环节
        assert version.json()["status"] == PolicyStatus.ACTIVE.value

        listed = seeded_client.get(f"/api/v1/policies/{definition_id}/versions", headers=json_headers)
        assert listed.status_code == 200
        assert listed.json()["total"] == 1

    def test_resolve_endpoint(self, seeded_client, json_headers):
        created = seeded_client.post(
            "/api/v1/policies",
            headers=json_headers,
            json={"policy_code": "REBATE", "name": "返点规则", "scope_type": "GLOBAL"},
        ).json()
        version = seeded_client.post(
            f"/api/v1/policies/{created['id']}/versions",
            headers=json_headers,
            json={"effective_from": "2026-01-01", "config": {"rate": "5"}},
        ).json()
        seeded_client.post(
            f"/api/v1/policy-versions/{version['id']}/approve",
            headers=json_headers,
            json={"approver": "pytest"},
        )
        found = seeded_client.get(
            "/api/v1/policy-versions/resolve",
            headers=json_headers,
            params={"policy_code": "REBATE", "on": "2026-06-01"},
        )
        assert found.status_code == 200
        assert found.json()["found"] is True
        assert found.json()["version"]["config"] == {"rate": "5"}

    def test_overlap_returns_422(self, seeded_client, json_headers):
        """项目约定：Validation → 422（见 test_pools_api / test_order_types_api）。

        注意：无失效日的版本会被新版本接续封口（见 TestPolicyVersion），因此真重叠
        需要旧版本本身带失效日、新版本起点落在其区间内。
        """
        created = seeded_client.post(
            "/api/v1/policies",
            headers=json_headers,
            json={"policy_code": "REBATE", "name": "返点规则", "scope_type": "GLOBAL"},
        ).json()
        seeded_client.post(
            f"/api/v1/policies/{created['id']}/versions",
            headers=json_headers,
            json={"effective_from": "2026-01-01", "effective_to": "2026-12-31", "config": {"rate": "5"}},
        )
        conflict = seeded_client.post(
            f"/api/v1/policies/{created['id']}/versions",
            headers=json_headers,
            json={"effective_from": "2026-06-01", "config": {"rate": "8"}},
        )
        assert conflict.status_code == 422

    def test_viewer_cannot_manage_policy(self, seeded_client, viewer_json_headers):
        response = seeded_client.post(
            "/api/v1/policies",
            headers=viewer_json_headers,
            json={"policy_code": "X", "name": "X", "scope_type": "GLOBAL"},
        )
        assert response.status_code == 403

    def test_policy_read_follows_manage_or_approve_permissions(self, seeded_client):
        auditor = seeded_client.get(
            "/api/v1/policies", headers={"X-Dev-User": "auditor"}
        )
        assert auditor.status_code == 200, auditor.text

        operator = seeded_client.get(
            "/api/v1/policies", headers={"X-Dev-User": "operator"}
        )
        assert operator.status_code == 403, operator.text

def test_supersede_active_policy_version_rejected(seeded_db):
    definition = _make_policy(seeded_db, code="SUP-TEST")
    version = policy_versions.create_version(
        seeded_db, definition["id"], effective_from=date(2027, 1, 1),
        effective_to=date(2027, 12, 31), config={"rate": "10"}, actor="pytest",
    )
    with pytest.raises(Validation):
        policy_versions.supersede_draft_version(
            seeded_db, version["id"], actor="pytest", reason="已发布版本不可取消",
        )

def test_expire_sweep_marks_lapsed_versions_and_is_idempotent(seeded_db):
    definition = _make_policy(seeded_db, code="EXP-TEST")
    lapsed = policy_versions.create_version(
        seeded_db, definition["id"], effective_from=date(2026, 1, 1),
        effective_to=date(2026, 12, 31), config={"rate": "10"}, actor="pytest",
    )
    live = policy_versions.create_version(
        seeded_db, definition["id"], effective_from=date(2027, 1, 1),
        effective_to=None, config={"rate": "12"}, actor="pytest",
    )
    first = policy_versions.expire_lapsed_versions(
        seeded_db, on=date(2027, 1, 1), actor="pytest"
    )
    second = policy_versions.expire_lapsed_versions(
        seeded_db, on=date(2027, 1, 1), actor="pytest"
    )
    assert first["swept"] == 1
    assert lapsed["id"] in first["version_ids"]
    assert live["id"] not in first["version_ids"]
    assert seeded_db.get(PolicyVersion, lapsed["id"]).status == PolicyStatus.EXPIRED.value
    assert seeded_db.get(PolicyVersion, live["id"]).status == PolicyStatus.ACTIVE.value
    assert second["swept"] == 0
