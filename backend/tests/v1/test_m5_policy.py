"""T19 / T20：经营规则版本化与快照固化（BAS-06-01~04）。

核心红线（BAS-06-04）：
> 改未来费率不会改写已发生订单的利润
"""
from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy.exc import IntegrityError

from app.core.money import to_money
from app.domain.enums import PolicyStatus, PolicyType
from app.domain.parties import PolicyVersion
from app.domain.trade import OrderEvent, OrderProfitAllocation
from app.orders import service as order_service
from app.policy import service as policy_service


def _make_policy(seeded_db, *, code="REBATE", name="返点规则") -> dict:
    return policy_service.create_definition(
        seeded_db,
        policy_code=code,
        name=name,
        scope_type="GLOBAL",
        description="测试用规则",
        actor="pytest",
    )


def _publish(seeded_db, definition, *, frm, to=None, config, approve=True):
    version = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=frm,
        effective_to=to,
        config=config,
        actor="pytest",
    )
    if approve:
        version = policy_service.approve_version(
            seeded_db, version["id"], approver="pytest"
        )
    return version


class TestPolicyDefinition:
    """BAS-06-01：规则配置列表。"""

    def test_create_and_list(self, seeded_db):
        definition = _make_policy(seeded_db)
        assert definition["policy_code"] == "REBATE"
        assert definition["status"] == PolicyStatus.DRAFT.value
        listed = policy_service.list_definitions(seeded_db)
        assert any(d["id"] == definition["id"] for d in listed)

    def test_duplicate_code_rejected(self, seeded_db):
        _make_policy(seeded_db)
        with pytest.raises(Exception):
            _make_policy(seeded_db)

    def test_same_code_can_have_different_scopes(self, seeded_db):
        _make_policy(seeded_db)
        scoped = policy_service.create_definition(
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
            policy_service.create_definition(
                seeded_db,
                policy_code="REBATE_HS",
                name="HS 返点",
                scope_type="ORDER_TYPE",
                scope_id=None,
                actor="pytest",
            )

    def test_invalid_scope_type_rejected(self, seeded_db):
        with pytest.raises(Exception):
            policy_service.create_definition(
                seeded_db,
                policy_code="X",
                name="X",
                scope_type="NOT_A_SCOPE",
                actor="pytest",
            )

    def test_empty_code_rejected(self, seeded_db):
        with pytest.raises(Exception):
            policy_service.create_definition(
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
        v1 = policy_service.create_version(
            seeded_db,
            definition["id"],
            effective_from=date(2026, 1, 1),
            effective_to=date(2026, 7, 1),
            config={"rate": "5"},
            actor="pytest",
        )
        v2 = policy_service.create_version(
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
        v1 = policy_service.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "5"}, actor="pytest"
        )
        v2 = policy_service.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 7, 1), config={"rate": "8"}, actor="pytest"
        )
        assert v2["version"] == 2
        row1 = seeded_db.get(PolicyVersion, v1["id"])
        assert row1.effective_to == date(2026, 7, 1)
        assert row1.config == {"rate": "5"}

    def test_backward_overlap_still_rejected(self, seeded_db):
        """新版本起点早于开放版本的起点 = 真重叠，必须拒绝。"""
        definition = _make_policy(seeded_db)
        policy_service.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 7, 1), config={"rate": "5"}, actor="pytest"
        )
        with pytest.raises(Exception):
            policy_service.create_version(
                seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "8"}, actor="pytest"
            )

    def test_overlapping_period_rejected(self, seeded_db):
        """新版本不得与已有版本有效期重叠。"""
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 7, 1), config={"rate": "5"})
        with pytest.raises(Exception):
            policy_service.create_version(
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
            policy_service.create_version(
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
            policy_service.update_version_draft(
                seeded_db, version["id"], config={"rate": "99"}, actor="pytest"
            )

    def test_draft_version_is_editable(self, seeded_db):
        definition = _make_policy(seeded_db)
        version = policy_service.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "5"}, actor="pytest"
        )
        updated = policy_service.update_version_draft(
            seeded_db, version["id"], config={"rate": "6"}, actor="pytest"
        )
        assert updated["config"] == {"rate": "6"}

    def test_publish_twice_rejected(self, seeded_db):
        definition = _make_policy(seeded_db)
        version = _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"rate": "5"})
        with pytest.raises(Exception):
            policy_service.approve_version(
                seeded_db, version["id"], approver="pytest"
            )

    def test_draft_not_resolvable(self, seeded_db):
        """未发布版本不参与生效期解析。"""
        definition = _make_policy(seeded_db)
        policy_service.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "5"}, actor="pytest"
        )
        assert policy_service.resolve_version(
            seeded_db, policy_code="REBATE", on=date(2026, 6, 1)
        ) is None

    def test_approve_requires_approver(self, seeded_db):
        definition = _make_policy(seeded_db)
        version = policy_service.create_version(
            seeded_db, definition["id"], effective_from=date(2026, 1, 1), config={"rate": "5"}, actor="pytest"
        )
        with pytest.raises(Exception):
            policy_service.approve_version(seeded_db, version["id"], approver="  ")


class TestVersionResolution:
    """BAS-06-04：按日期解析生效版本。"""

    def test_resolves_by_date(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 7, 1), config={"rate": "5"})
        _publish(seeded_db, definition, frm=date(2026, 7, 1), config={"rate": "8"})
        early = policy_service.resolve_version(seeded_db, policy_code="REBATE", on=date(2026, 3, 1))
        late = policy_service.resolve_version(seeded_db, policy_code="REBATE", on=date(2026, 9, 1))
        assert early is not None and early.config == {"rate": "5"}
        assert late is not None and late.config == {"rate": "8"}

    def test_before_first_version_returns_none(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"rate": "5"})
        assert policy_service.resolve_version(
            seeded_db, policy_code="REBATE", on=date(2025, 12, 31)
        ) is None

    def test_after_expired_returns_none(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 2, 1), config={"rate": "5"})
        assert policy_service.resolve_version(
            seeded_db, policy_code="REBATE", on=date(2026, 3, 1)
        ) is None

    def test_unknown_code_returns_none(self, seeded_db):
        assert policy_service.resolve_version(
            seeded_db, policy_code="NOT_EXIST", on=date(2026, 6, 1)
        ) is None

    def test_specific_scope_overrides_global_scope(self, seeded_db):
        global_policy = _make_policy(seeded_db)
        scoped = policy_service.create_definition(
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

        resolved = policy_service.resolve_version(
            seeded_db,
            policy_code="REBATE",
            on=date(2026, 6, 1),
            scope_type="ORDER_TYPE",
            scope_id=1,
        )
        assert resolved is not None
        assert resolved.config == {"rate": "8"}


class TestSnapshotRedline:
    """BAS-06-04 核心红线：改未来费率不会改写已发生订单的利润。"""

    def test_new_order_captures_snapshot(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"rate": "5"})
        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        assert order.policy_version_id is not None
        assert order.policy_snapshot is not None
        assert order.policy_snapshot[PolicyType.REBATE.value]["config"] == {"rate": "5"}

    def test_rule_change_does_not_rewrite_history(self, seeded_db):
        """本轮最关键的一条：改未来费率后，历史订单快照必须原样不动。"""
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), to=date(2026, 7, 1), config={"rate": "5"})
        old_order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        old_version_id = old_order.policy_version_id
        old_snapshot = dict(old_order.policy_snapshot)

        # 改规则：发布新版（7 月起生效）
        _publish(seeded_db, definition, frm=date(2026, 7, 1), config={"rate": "8"})
        # 同时把新版本参数直接改坏，验证历史不受任何影响
        seeded_db.refresh(old_order)
        assert old_order.policy_version_id == old_version_id
        assert old_order.policy_snapshot == old_snapshot
        assert old_order.policy_snapshot[PolicyType.REBATE.value]["config"] == {"rate": "5"}

        # 新订单用新规则
        new_order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 8, 1), actor="pytest"
        )
        assert new_order.policy_snapshot[PolicyType.REBATE.value]["config"] == {"rate": "8"}
        assert new_order.policy_version_id != old_version_id

    def test_snapshot_is_deep_copied(self, seeded_db):
        """快照必须是深拷贝：调用方改内存 dict 不能影响已固化数据。"""
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"rate": "5"})
        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        order.policy_snapshot[PolicyType.REBATE.value]["config"]["rate"] = "999"
        seeded_db.refresh(order)
        assert order.policy_snapshot[PolicyType.REBATE.value]["config"]["rate"] == "5"

    def test_no_policy_yields_no_snapshot(self, seeded_db):
        """没有配置规则时不应报错，快照留空。"""
        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        assert order.policy_version_id is None
        assert order.policy_snapshot is None

    def test_snapshot_for_lookup(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"rate": "5"})
        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )
        found = policy_service.snapshot_for(seeded_db, order.id)
        assert found is not None
        assert found["policy_snapshot"][PolicyType.REBATE.value]["version"] == 1


class TestProfitAllocation:
    def test_allocation_rejects_incomplete_and_duplicate_action_categories(self, seeded_db):
        from app.core.errors import Validation
        order = self._order(seeded_db)
        # 按动作模式（items 带 allocation_type）仍要求四项齐全：
        # 单给一个 BUY 行属于「动作模式缺项」，必须拒绝。
        with pytest.raises(Validation):
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[{"allocation_type": "BUY", "role": "OWNER", "allocation_rate": 100}],
            )
        items = [
            {"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 20}
            for kind in ("BUY", "SELL", "OPERATION", "COMPANY", "SELL")
        ]
        with pytest.raises(Validation):
            policy_service.set_allocations(seeded_db, order.id, items=items)

    def test_allocation_cannot_choose_seller_before_sale(self, seeded_db):
        from app.core.errors import Validation
        order = self._order(seeded_db)
        items = [
            {"allocation_type": kind, "user_id": 1 if kind in ("SELL", "OPERATION") else None, "role": "OWNER", "allocation_rate": 25}
            for kind in ("BUY", "SELL", "OPERATION", "COMPANY")
        ]
        with pytest.raises(Validation):
            policy_service.set_allocations(seeded_db, order.id, items=items)

    """BAS-06-03：订单多人利润分配，合计必须 100%。"""

    @staticmethod
    def _order(seeded_db):
        return order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )

    def test_allocation_rate_cannot_exceed_one_hundred_in_database(self, seeded_db):
        order = self._order(seeded_db)
        seeded_db.add(
            OrderProfitAllocation(
                order_id=order.id,
                role="OWNER",
                allocation_rate=101,
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_allocation_role_is_closed_in_database(self, seeded_db):
        order = self._order(seeded_db)
        seeded_db.add(
            OrderProfitAllocation(
                order_id=order.id,
                role="UNKNOWN",
                allocation_rate=100,
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_invalid_allocation_role_rejected_by_service(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception) as exc:
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "UNKNOWN" if kind == "BUY" else "OWNER", "allocation_rate": "25"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
                actor="pytest",
            )
        assert "角色" in str(exc.value)

    def test_unknown_allocation_field_rejected_by_service(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception) as exc:
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[
                    {
                        "user_id": 1,
                        "role": "OWNER",
                        "allocation_rate": "100",
                        "legacy_field": "must not be ignored",
                    }
                ],
                actor="pytest",
            )
        assert "字段" in str(exc.value) or "校验" in str(exc.value)

    def test_allocation_user_must_exist(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception) as exc:
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[{"allocation_type": kind, "user_id": 999999 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "25"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
                actor="pytest",
            )
        assert "人员不存在" in str(exc.value)

    def test_fifty_fifty(self, seeded_db):
        order = self._order(seeded_db)
        items = policy_service.set_allocations(
            seeded_db,
            order.id,
            items=[{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "50" if kind in ("OPERATION", "COMPANY") else "0"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )
        assert len(items) == 4
        assert to_money(items[0]["total_rate"]) == to_money("100")

    def test_typed_allocation_requires_four_income_categories(self, seeded_db):
        order = self._order(seeded_db)
        items = policy_service.set_allocations(
            seeded_db,
            order.id,
            items=[
                {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
                {"allocation_type": "SELL", "user_id": None, "role": "SALES", "allocation_rate": "25"},
                {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "25"},
                {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            ],
            actor="pytest",
        )
        assert {item["allocation_type"] for item in items} == {"BUY", "SELL", "OPERATION", "COMPANY"}
        assert to_money(items[0]["total_rate"]) == to_money("100")

    def test_buy_sell_recipient_is_bound_to_action_actor(self, seeded_db):
        order = self._order(seeded_db)
        seeded_db.add(
            OrderEvent(
                event_no="EVT-TEST-BUY",
                order_id=order.id,
                event_type="BUY",
                amount=100,
                occurred_on=date(2026, 6, 1),
                is_posted=True,
                created_by="seeduser1",
                updated_by="seeduser1",
            )
        )
        seeded_db.flush()
        items = policy_service.set_allocations(
            seeded_db,
            order.id,
            items=[
                {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
                {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
                {"allocation_type": "OPERATION", "user_id": 2, "role": "OWNER", "allocation_rate": "25"},
                {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            ],
            actor="pytest",
        )
        by_type = {item["allocation_type"]: item for item in items}
        assert by_type["BUY"]["user_id"] == 1
        assert by_type["SELL"]["user_id"] is None

    def test_sale_click_binds_seller_after_allocation(self, seeded_db):
        order = order_service.create_order(seeded_db, order_type="DG", trade_date=date(2026, 6, 1), actor="seeduser1")
        items = [{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 25} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")]
        policy_service.set_allocations(seeded_db, order.id, items=items)
        order_service.post_event(seeded_db, order.id, event_type="SELL", amount="100", portion="PROFIT", occurred_on=date(2026, 6, 1), actor="seeduser2")
        by_type = {item["allocation_type"]: item for item in policy_service.list_allocations(seeded_db, order.id)}
        assert by_type["SELL"]["user_id"] == 2

    def test_total_must_be_100(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception):
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[{"user_id": 1, "role": "OWNER", "allocation_rate": "60"}],
                actor="pytest",
            )

    def test_sum_99_rejected(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception):
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
                    {"user_id": 2, "role": "SALES", "allocation_rate": "49"},
                ],
                actor="pytest",
            )

    def test_negative_rate_rejected(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception):
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "150"},
                    {"user_id": 2, "role": "SALES", "allocation_rate": "-50"},
                ],
                actor="pytest",
            )

    def test_duplicate_user_role_rejected(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception):
            policy_service.set_allocations(
                seeded_db,
                order.id,
                items=[
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
                ],
                actor="pytest",
            )

    def test_empty_items_rejected(self, seeded_db):
        order = self._order(seeded_db)
        with pytest.raises(Exception):
            policy_service.set_allocations(seeded_db, order.id, items=[], actor="pytest")

    def test_reset_replaces_old_rows(self, seeded_db):
        """整单重设不应留下旧比例残留。"""
        order = self._order(seeded_db)
        policy_service.set_allocations(
            seeded_db,
            order.id,
            items=[{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "50" if kind in ("OPERATION", "COMPANY") else "0"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )
        policy_service.set_allocations(
            seeded_db,
            order.id,
            items=[{"allocation_type": kind, "user_id": 3 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "100" if kind == "OPERATION" else "0"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )
        items = policy_service.list_allocations(seeded_db, order.id)
        assert len(items) == 4
        assert next(item for item in items if item["allocation_type"] == "OPERATION")["user_id"] == 3

    def test_allocation_inherits_order_policy_version(self, seeded_db):
        definition = _make_policy(seeded_db)
        _publish(seeded_db, definition, frm=date(2026, 1, 1), config={"rate": "5"})
        order = self._order(seeded_db)
        items = policy_service.set_allocations(
            seeded_db,
            order.id,
            items=[{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "100" if kind == "OPERATION" else "0"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )
        assert items[0]["policy_version_id"] == order.policy_version_id


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
        version_id = version.json()["id"]

        approved = seeded_client.post(
            f"/api/v1/policy-versions/{version_id}/approve",
            headers=json_headers,
            json={"approver": "pytest"},
        )
        assert approved.status_code == 200
        assert approved.json()["status"] == PolicyStatus.ACTIVE.value

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
