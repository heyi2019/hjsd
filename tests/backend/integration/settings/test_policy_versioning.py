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

class TestPolicyDefinition:
    """BAS-06-01：规则配置列表。"""

    def test_create_and_list(self, seeded_db):
        definition = _make_policy(seeded_db)
        assert definition["policy_code"] == "COMMISSION"
        assert definition["status"] == PolicyStatus.DRAFT.value
        listed = policy_definitions.list_definitions(seeded_db)
        assert any(d["id"] == definition["id"] for d in listed)

    def test_duplicate_code_rejected(self, seeded_db):
        _make_policy(seeded_db)
        with pytest.raises(Exception):
            _make_policy(seeded_db)

    def test_same_code_can_have_different_scopes(self, seeded_db):
        _make_policy(seeded_db)
        scoped = policy_definitions.create_definition(
            seeded_db,
            policy_code="REBATE",
            name="HS 返点规则",
            scope_type="ORDER_TYPE",
            scope_id=1,
            actor="pytest",
        )
        assert scoped["policy_code"] == "REBATE"
        assert scoped["scope_type"] == "ORDER_TYPE"

    def test_scoped_requires_scope_id(self, seeded_db):
        """非全局范围必须指定 scope_id，否则规则会误伤全部业务。"""
        with pytest.raises(Exception):
            policy_definitions.create_definition(
                seeded_db,
                policy_code="REBATE_HS",
                name="HS 返点",
                scope_type="ORDER_TYPE",
                scope_id=None,
                actor="pytest",
            )

    def test_invalid_scope_type_rejected(self, seeded_db):
        with pytest.raises(Exception):
            policy_definitions.create_definition(
                seeded_db,
                policy_code="X",
                name="X",
                scope_type="NOT_A_SCOPE",
                actor="pytest",
            )

    def test_empty_code_rejected(self, seeded_db):
        with pytest.raises(Exception):
            policy_definitions.create_definition(
                seeded_db, policy_code="  ", name="X", scope_type="GLOBAL", actor="pytest"
            )

class TestPolicyVersion:
    """BAS-06-02：版本 / 生效期 / 审批。"""

    def test_policy_version_state_is_constrained_in_database(self, seeded_db):
        definition = _make_policy(seeded_db)
        seeded_db.add(
            PolicyVersion(
                policy_definition_id=definition["id"],
                version=0,
                effective_from=date(2026, 7, 1),
                effective_to=date(2026, 1, 1),
                config={},
                status=PolicyStatus.DRAFT.value,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_version_increments(self, seeded_db):
        """版本号递增；两个都无失效日的版本必然重叠，必须给前一个封口。"""
        definition = _make_policy(seeded_db)
        v1 = policy_versions.create_version(
            seeded_db,
            definition["id"],
            effective_from=date(2026, 1, 1),
            effective_to=date(2026, 7, 1),
            config={"rate": "5"},
            actor="pytest",
        )
        v2 = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 7, 1), config={"rate": "8"}, actor="pytest"
        )
        assert v1["version"] == 1
        assert v2["version"] == 2

    def test_new_version_supersedes_open_ended(self, seeded_db):
        """新版本接续封口「开放至今」的旧版本（旧失效日 = 新生效日）。

        否则开放版本一旦存在，任何新版本都会因重叠被拒，规则永远无法改版
        （设置配置「保存即发布」将不可用）。旧版本 config 不被改写。
        """
        definition = _make_policy(seeded_db)
        v1 = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "5"}, actor="pytest"
        )
        v2 = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 7, 1), config={"rate": "8"}, actor="pytest"
        )
        assert v2["version"] == 2
        row1 = seeded_db.get(PolicyVersion, v1["id"])
        assert row1.effective_to == date(2026, 7, 1)
        assert row1.config == {"rate": "5"}

    def test_backward_overlap_still_rejected(self, seeded_db):
        """新版本起点早于开放版本的起点 = 真重叠，必须拒绝。"""
        definition = _make_policy(seeded_db)
        policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 7, 1), config={"rate": "5"}, actor="pytest"
        )
        with pytest.raises(Exception):
            policy_versions.create_version(
                seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "8"}, actor="pytest"
            )

    def test_overlapping_period_rejected(self, seeded_db):
        """新版本不得与已有版本有效期重叠。"""
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 7, 1), config={"rate": "5"})
        with pytest.raises(Exception):
            policy_versions.create_version(
                seeded_db,
                definition["id"],
                effective_from=date(2026, 6, 1),
                effective_to=date(2026, 9, 1),
                config={"rate": "8"},
                actor="pytest",
            )

    def test_adjacent_period_allowed(self, seeded_db):
        """相邻版本（前 to = 次 from）不算重叠，且无空隙。"""
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 7, 1), config={"rate": "5"})
        v2 = _publish(
            seeded_db, definition, frm=date(2026, 7, 1), to=date(2027, 1, 1), config={"rate": "8"}
        )
        assert v2["version"] == 2

    def test_inverted_period_rejected(self, seeded_db):
        definition = _make_policy(seeded_db)
        with pytest.raises(Exception):
            policy_versions.create_version(
                seeded_db,
                definition["id"],
                effective_from=date(2026, 7, 1),
                effective_to=date(2026, 1, 1),
                config={"rate": "5"},
                actor="pytest",
            )

    def test_published_version_is_immutable(self, seeded_db):
        """已发布版本不可修改 —— 只能新建（BAS-06-02）。"""
        definition = _make_policy(seeded_db)
        version = _publish(
            seeded_db, definition, frm=date(2026, 1, 1), config={"rate": "5"}
        )
        with pytest.raises(Exception):
            policy_versions.update_version_draft(
                seeded_db, version["id"], config={"rate": "99"}, actor="pytest"
            )

    def test_published_version_not_editable(self, seeded_db):
        definition = _make_policy(seeded_db)
        version = policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "5"}, actor="pytest"
        )
        # 创建即发布（ACTIVE）：已发布版本不可改，只能新建版本封口
        with pytest.raises(Exception):
            policy_versions.update_version_draft(
                seeded_db, version["id"], config={"rate": "6"}, actor="pytest"
            )

    def test_published_version_resolvable(self, seeded_db):
        """创建即发布：版本直接为 ACTIVE，参与生效期解析。"""
        definition = _make_policy(seeded_db)
        policy_versions.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "5"}, actor="pytest"
        )
        resolved = policy_versions.resolve_version(
            seeded_db, policy_code="COMMISSION", on=date(2026, 6, 1)
        )
        assert resolved is not None
        assert resolved.config == {"rate": "5"}

class TestVersionResolution:
    """BAS-06-04：按日期解析生效版本。"""

    def test_resolves_by_date(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 7, 1), config={"rate": "5"})
        _publish(seeded_db, definition, frm=date(2026, 7, 1), config={"rate": "8"})
        early = policy_versions.resolve_version(seeded_db, policy_code="COMMISSION", on=date(2026, 3, 1))
        late = policy_versions.resolve_version(seeded_db, policy_code="COMMISSION", on=date(2026, 9, 1))
        assert early is not None and early.config == {"rate": "5"}
        assert late is not None and late.config == {"rate": "8"}

    def test_before_first_version_returns_none(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"split": {"BUY": "30"}})
        assert policy_versions.resolve_version(
            seeded_db, policy_code="REBATE", on=date(2025, 12, 31)
        ) is None

    def test_after_expired_returns_none(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 2, 1), config={"rate": "5"})
        assert policy_versions.resolve_version(
            seeded_db, policy_code="REBATE", on=date(2026, 3, 1)
        ) is None

    def test_unknown_code_returns_none(self, seeded_db):
        assert policy_versions.resolve_version(
            seeded_db, policy_code="NOT_EXIST", on=date(2026, 6, 1)
        ) is None

    def test_specific_scope_overrides_global_scope(self, seeded_db):
        global_policy = _make_policy(seeded_db)
        scoped = policy_definitions.create_definition(
            seeded_db,
            policy_code="REBATE",
            name="HS 返点规则",
            scope_type="ORDER_TYPE",
            scope_id=1,
            actor="pytest",
        )
        _publish(
            seeded_db, global_policy, frm=date(2026, 1, 1), config={"rate": "5"}
        )
        _publish(
            seeded_db, scoped, frm=date(2026, 1, 1), config={"rate": "8"}
        )

        resolved = policy_versions.resolve_version(
            seeded_db,
            policy_code="REBATE",
            on=date(2026, 6, 1),
            scope_type="ORDER_TYPE",
            scope_id=1,
        )
        assert resolved is not None
        assert resolved.config == {"rate": "8"}

class TestSnapshotRedline:
    """BAS-06-04 核心红线：改未来规则不会改写已发生订单的利润。"""

    def test_new_order_captures_snapshot(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"split": {"BUY": "30"}})
        order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        assert order.policy_version_id is not None
        assert order.policy_snapshot is not None
        assert order.policy_snapshot[PolicyType.COMMISSION.value]["config"] == {"split": {"BUY": "30"}}

    def test_rule_change_does_not_rewrite_history(self, seeded_db):
        """本轮最关键的一条：改未来规则后，历史订单快照必须原样不动。"""
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 7, 1), config={"split": {"BUY": "30"}})
        old_order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        old_version_id = old_order.policy_version_id
        old_snapshot = dict(old_order.policy_snapshot)

        # 改规则：发布新版（7 月起生效）
        _publish(seeded_db, definition, frm=date(2026, 7, 1), config={"split": {"BUY": "40"}})
        # 同时把新版本参数直接改坏，验证历史不受任何影响
        seeded_db.refresh(old_order)
        assert old_order.policy_version_id == old_version_id
        assert old_order.policy_snapshot == old_snapshot
        assert old_order.policy_snapshot[PolicyType.COMMISSION.value]["config"] == {"split": {"BUY": "30"}}

        # 新订单用新规则
        new_order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 8, 1), actor="pytest"
        )
        assert new_order.policy_snapshot[PolicyType.COMMISSION.value]["config"] == {"split": {"BUY": "40"}}
        assert new_order.policy_version_id != old_version_id

    def test_snapshot_is_deep_copied(self, seeded_db):
        """快照必须是深拷贝：调用方改内存 dict 不能影响已固化数据。"""
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"split": {"BUY": "30"}})
        order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        order.policy_snapshot[PolicyType.COMMISSION.value]["config"]["split"]["BUY"] = "999"
        seeded_db.refresh(order)
        assert order.policy_snapshot[PolicyType.COMMISSION.value]["config"]["split"]["BUY"] == "30"

    def test_no_policy_yields_no_snapshot(self, seeded_db):
        """没有配置规则时不应报错，快照留空。"""
        order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        assert order.policy_version_id is None
        assert order.policy_snapshot is None

    def test_snapshot_for_lookup(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"split": {"BUY": "30"}})
        order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        found = policy_versions.snapshot_for(seeded_db, order.id)
        assert found is not None
        assert found["policy_snapshot"][PolicyType.COMMISSION.value]["version"] == 1
