"""POLICY-01 T20：订单利润分润配置与角色守卫（BAS-06-03）。

核心红线（BAS-06-04）：
> 改未来费率不会改写已发生订单的利润
"""
from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy.exc import IntegrityError

from app.core.errors import Validation
from app.core.money import to_money
from app.domain.trade import OrderEvent, OrderProfitAllocation
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.funds.profit_allocation import service as policy_allocations
from app.funds.profit_allocation.listing import list_allocations



@pytest.fixture()
def json_headers(headers):
    """带 Content-Type 的写入头（默认 headers fixture 只有身份头）。"""
    return {**headers, "Content-Type": "application/json"}

@pytest.fixture()
def viewer_json_headers(viewer_headers):
    return {**viewer_headers, "Content-Type": "application/json"}

class TestProfitAllocation:
    def test_allocation_rejects_incomplete_and_duplicate_action_categories(self, seeded_db):
        from app.core.errors import Validation
        order = self._order(seeded_db)
        # 按动作模式（items 带 allocation_type）仍要求四项齐全：
        # 单给一个 BUY 行属于「动作模式缺项」，必须拒绝。
        with pytest.raises(Validation):
            policy_allocations.set_allocations(
                seeded_db,
                order.id,
                items=[{"allocation_type": "BUY", "role": "OWNER", "allocation_rate": 100}],
            )
        items = [
            {"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 20}
            for kind in ("BUY", "SELL", "OPERATION", "COMPANY", "SELL")
        ]
        with pytest.raises(Validation):
            policy_allocations.set_allocations(seeded_db, order.id, items=items)

    def test_allocation_splits_one_action_across_multiple_executors(self, seeded_db):
        """一个动作多人：买号 2 人各占一半份额（30% → 15% / 15%），允许 5 行落库。"""
        order = self._sold_order(seeded_db)
        # 买号动作登记了 2 位业务负责人 → 分润按 2 行均分。
        order.form_extra = {**(order.form_extra or {}), "business_responsible_ids": [1, 7]}
        seeded_db.flush()
        items = [
            {"allocation_type": "BUY", "user_id": 1, "role": "BUYER", "allocation_rate": "15"},
            {"allocation_type": "BUY", "user_id": 7, "role": "BUYER", "allocation_rate": "15"},
            {"allocation_type": "SELL", "user_id": None, "role": "SALES", "allocation_rate": "40"},
            {"allocation_type": "OPERATION", "user_id": 2, "role": "SERVICE", "allocation_rate": "20"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "10"},
        ]
        listed = policy_allocations.set_allocations(seeded_db, order.id, items=items)

        buy_rows = [item for item in listed if item["allocation_type"] == "BUY"]
        assert len(buy_rows) == 2
        assert {item["user_id"] for item in buy_rows} == {1, 7}
        assert [to_money(item["allocation_rate"]) for item in buy_rows] == [to_money("15"), to_money("15")]
        # 四项合计仍是 100%，没有被 5 行撑大
        assert to_money(listed[0]["total_rate"]) == to_money("100")

    def test_allocation_rejects_same_person_twice_in_one_action(self, seeded_db):
        """同一动作下同一人不能占两行，否则等于自己和自己均分。"""
        from app.core.errors import Validation
        order = self._order(seeded_db)
        order.form_extra = {**(order.form_extra or {}), "business_responsible_ids": [1, 7]}
        seeded_db.flush()
        items = [
            {"allocation_type": "BUY", "user_id": 1, "role": "BUYER", "allocation_rate": "15"},
            {"allocation_type": "BUY", "user_id": 1, "role": "BUYER", "allocation_rate": "15"},
            {"allocation_type": "SELL", "user_id": None, "role": "SALES", "allocation_rate": "40"},
            {"allocation_type": "OPERATION", "user_id": 2, "role": "SERVICE", "allocation_rate": "20"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "10"},
        ]
        with pytest.raises(Validation):
            policy_allocations.set_allocations(seeded_db, order.id, items=items)

    def test_allocation_rejects_multiple_company_rows(self, seeded_db):
        """公司行仍然只能有一行。"""
        from app.core.errors import Validation
        order = self._order(seeded_db)
        order.form_extra = {**(order.form_extra or {}), "business_responsible_ids": [1]}
        seeded_db.flush()
        items = [
            {"allocation_type": "BUY", "user_id": 1, "role": "BUYER", "allocation_rate": "20"},
            {"allocation_type": "SELL", "user_id": None, "role": "SALES", "allocation_rate": "40"},
            {"allocation_type": "OPERATION", "user_id": 2, "role": "SERVICE", "allocation_rate": "20"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "10"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "10"},
        ]
        with pytest.raises(Validation):
            policy_allocations.set_allocations(seeded_db, order.id, items=items)

    def test_allocation_cannot_choose_seller_before_sale(self, seeded_db):
        from app.core.errors import Validation
        order = self._order(seeded_db)
        items = [
            {"allocation_type": kind, "user_id": 1 if kind in ("SELL", "OPERATION") else None, "role": "OWNER", "allocation_rate": 25}
            for kind in ("BUY", "SELL", "OPERATION", "COMPANY")
        ]
        with pytest.raises(Validation):
            policy_allocations.set_allocations(seeded_db, order.id, items=items)

    """BAS-06-03：订单多人利润分配，合计必须 100%。"""

    @staticmethod
    def _order(seeded_db):
        return create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 6, 1), actor="pytest"
        )

    @staticmethod
    def _sold_order(seeded_db):
        order = TestProfitAllocation._order(seeded_db)
        order.status = "COMPLETED"
        seeded_db.flush()
        return order

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
        order = self._sold_order(seeded_db)
        with pytest.raises(Exception) as exc:
            policy_allocations.set_allocations(
                seeded_db,
                order.id,
                items=[{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "UNKNOWN" if kind == "BUY" else "OWNER", "allocation_rate": "25"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
                actor="pytest",
            )
        assert "角色" in str(exc.value)

    def test_unknown_allocation_field_rejected_by_service(self, seeded_db):
        order = self._sold_order(seeded_db)
        with pytest.raises(Exception) as exc:
            policy_allocations.set_allocations(
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
        order = self._sold_order(seeded_db)
        with pytest.raises(Exception) as exc:
            policy_allocations.set_allocations(
                seeded_db,
                order.id,
                items=[{"allocation_type": kind, "user_id": 999999 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "25"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
                actor="pytest",
            )
        assert "人员不存在" in str(exc.value)

    def test_fifty_fifty(self, seeded_db):
        order = self._sold_order(seeded_db)
        items = policy_allocations.set_allocations(
            seeded_db,
            order.id,
            items=[{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "50" if kind in ("OPERATION", "COMPANY") else "0"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )
        assert len(items) == 4
        assert to_money(items[0]["total_rate"]) == to_money("100")

    def test_typed_allocation_requires_four_income_categories(self, seeded_db):
        order = self._sold_order(seeded_db)
        items = policy_allocations.set_allocations(
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
        order = self._sold_order(seeded_db)
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
        items = policy_allocations.set_allocations(
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

    def test_action_allocations_use_order_and_sale_responsibles(self, seeded_db):
        order = self._sold_order(seeded_db)
        order.form_extra = {
            "business_responsible_ids": [3],
            "delivery_responsible_ids": [1],
            "sell_delivery_responsible_ids": [3],
        }
        seeded_db.add_all([
            OrderEvent(
                event_no="EVT-TEST-BUY-FORM",
                order_id=order.id,
                event_type="BUY",
                amount=100,
                occurred_on=date(2026, 6, 1),
                is_posted=True,
                created_by="seeduser1",
                updated_by="seeduser1",
            ),
            OrderEvent(
                event_no="EVT-TEST-SELL-FORM",
                order_id=order.id,
                event_type="SELL",
                amount=200,
                occurred_on=date(2026, 6, 2),
                is_posted=True,
                created_by="seeduser2",
                updated_by="seeduser2",
            ),
        ])
        seeded_db.flush()

        items = policy_allocations.set_allocations(
            seeded_db,
            order.id,
            items=[
                {"allocation_type": "BUY", "user_id": 3, "role": "BUYER", "allocation_rate": "25"},
                {"allocation_type": "SELL", "user_id": 3, "role": "SALES", "allocation_rate": "25"},
                {"allocation_type": "OPERATION", "user_id": 2, "role": "SERVICE", "allocation_rate": "25"},
                {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            ],
            actor="pytest",
        )
        by_type = {item["allocation_type"]: item for item in items}
        assert by_type["BUY"]["user_id"] == 3
        assert by_type["SELL"]["user_id"] == 3

    def test_sale_completion_binds_seller_for_allocation(self, seeded_db):
        order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 6, 1), actor="seeduser1")
        items = [{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 25} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")]
        with pytest.raises(Exception, match="订单售出完成后才能配置分润"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items)
        post_event(seeded_db, order.id, event_type="SELL", amount="100", portion="PROFIT", occurred_on=date(2026, 6, 1), actor="seeduser2")
        policy_allocations.set_allocations(seeded_db, order.id, items=items)
        by_type = {item["allocation_type"]: item for item in list_allocations(seeded_db, order.id)}
        assert by_type["SELL"]["user_id"] == 2

    def test_total_must_be_100(self, seeded_db):
        order = self._sold_order(seeded_db)
        with pytest.raises(Validation, match="有效分配比例合计必须为 100%"):
            policy_allocations.set_allocations(
                seeded_db,
                order.id,
                items=[{"user_id": 1, "role": "OWNER", "allocation_rate": "60"}],
                actor="pytest",
            )

    def test_sum_99_rejected(self, seeded_db):
        order = self._sold_order(seeded_db)
        with pytest.raises(Validation, match="有效分配比例合计必须为 100%"):
            policy_allocations.set_allocations(
                seeded_db,
                order.id,
                items=[
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
                    {"user_id": 2, "role": "SALES", "allocation_rate": "49"},
                ],
                actor="pytest",
            )

    def test_negative_rate_rejected(self, seeded_db):
        order = self._sold_order(seeded_db)
        with pytest.raises(Validation, match="分配比例/金额必须是数值"):
            policy_allocations.set_allocations(
                seeded_db,
                order.id,
                items=[
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "150"},
                    {"user_id": 2, "role": "SALES", "allocation_rate": "-50"},
                ],
                actor="pytest",
            )

    def test_duplicate_user_role_rejected(self, seeded_db):
        order = self._sold_order(seeded_db)
        with pytest.raises(Validation, match="同一人员在同一角色下不可重复分润"):
            policy_allocations.set_allocations(
                seeded_db,
                order.id,
                items=[
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
                    {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
                ],
                actor="pytest",
            )

    def test_empty_items_rejected(self, seeded_db):
        order = self._sold_order(seeded_db)
        with pytest.raises(Validation, match="分润不能为空"):
            policy_allocations.set_allocations(seeded_db, order.id, items=[], actor="pytest")

    def test_reset_replaces_old_rows(self, seeded_db):
        """整单重设不应留下旧比例残留。"""
        order = self._sold_order(seeded_db)
        policy_allocations.set_allocations(
            seeded_db,
            order.id,
            items=[{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "50" if kind in ("OPERATION", "COMPANY") else "0"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )
        policy_allocations.set_allocations(
            seeded_db,
            order.id,
            items=[{"allocation_type": kind, "user_id": 3 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": "100" if kind == "OPERATION" else "0"} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )
        items = list_allocations(seeded_db, order.id)
        assert len(items) == 4
        assert next(item for item in items if item["allocation_type"] == "OPERATION")["user_id"] == 3
