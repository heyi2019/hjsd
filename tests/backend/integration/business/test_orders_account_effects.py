"""API-01 订单取消/账户效果/池余额契约：三个 class 拆出。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountStatus,
    OrderStatus)
from app.business.inventory.profile import create_account
from app.domain.trade import Account, Cashflow
from app.business.shared.cancellation_model import cancel_order
from app.business.orders.create import create_order
from app.business.orders.events import _opposite_direction, post_event
from app.funds.balances import pool_balance

D = date(2026, 10, 4)

def _order(
    seeded_db,
    *,
    order_type="HS",
    account_id=None,
    owner_id=None,
    trade_date=D,
    form_extra=None,
):
    if order_type == "HS" and account_id is None:
        account_id = create_account(
            seeded_db,
            game_account=f"orders-contract-{uuid4().hex[:10]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        ).id
    return create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
        form_extra=form_extra,
    )

def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )


class TestCancelOffsetDirection:
    def test_opposite_direction_three_branches(self, seeded_db):
        from app.domain.enums import Direction

        # 分支一：offset 指向 BUY → 方向取反为 IN（每分支独立建单）
        order_a = _order(seeded_db)
        buy_a, _ = post_event(
            seeded_db, order_a.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        cancel_a, _ = post_event(
            seeded_db, order_a.id, event_type="CANCEL", amount="100.00",
            occurred_on=D, actor="pytest", offset_event_id=buy_a.id,
            reason="撤回全部买入款",
        )
        assert order_a.status == "CANCELLED"

        # 分支二：offset 指向 SELL → 方向取反为 OUT
        order_b = _order(seeded_db, order_type="TH")
        buy_event, _ = post_event(
            seeded_db, order_b.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        sell_event, _ = post_event(
            seeded_db, order_b.id, event_type="SELL", amount="150.00",
            occurred_on=D, actor="pytest", offset_event_id=buy_event.id,
        )
        cancel_b, _ = post_event(
            seeded_db, order_b.id, event_type="CANCEL", amount="10.00",
            occurred_on=D, actor="pytest", offset_event_id=sell_event.id,
            reason="买家部分退款",
        )

        # 分支三：offset 指向不存在的事件 → NotFound。FK 全局强制使经 post_event
        # 不可达（INSERT order_events 即失败，校验在 flush 之后），直调私有函数覆盖
        with pytest.raises(NotFound):
            _opposite_direction(999999, seeded_db)

        flows = {
            row.id: row
            for row in seeded_db.scalars(select(Cashflow)).all()
        }
        assert flows[cancel_a.id].direction == Direction.IN.value
        assert flows[cancel_b.id].direction == Direction.OUT.value

    def test_cancel_requires_reason_and_th_offset(self, seeded_db):
        hs = _order(seeded_db)
        _hs_buy, _ = post_event(
            seeded_db, hs.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_reason:
            post_event(
                seeded_db, hs.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest",
            )
        assert "原因" in str(missing_reason.value)

        with pytest.raises(Validation, match="offset_event_id"):
            post_event(
                seeded_db, hs.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason="回收退回",
            )

        th = _order(seeded_db, order_type="TH")
        post_event(
            seeded_db, th.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_offset:
            post_event(
                seeded_db, th.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason="同行未付成功",
            )
        assert "offset_event_id" in str(missing_offset.value)

    def test_cancel_reasons_require_text_values(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="取消必须填写原因"):
            cancel_order(
                seeded_db, order.id, actor="pytest", reason=123
            )

        post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation, match="CANCEL 必须填写冲销原因"):
            post_event(
                seeded_db, order.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason=123,
            )

    def test_cancel_cannot_exceed_offset_remaining_or_change_pool(self, seeded_db):
        order = _order(seeded_db, order_type="TH")
        buy, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest", pool_id=1,
        )

        with pytest.raises(Validation) as wrong_pool:
            post_event(
                seeded_db, order.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                pool_id=2, reason="资金账户更正",
            )
        assert "资金账户" in str(wrong_pool.value)

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="60.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退款",
        )
        assert order.status == OrderStatus.ACTIVE.value
        with pytest.raises(Validation) as over_cancel:
            post_event(
                seeded_db, order.id, event_type="CANCEL", amount="50.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                reason="再次退款",
            )
        assert "剩余可冲销" in str(over_cancel.value)

    def test_cancel_offset_must_belong_to_the_same_order(self, seeded_db):
        first = _order(seeded_db)
        second = _order(seeded_db, order_type="TH")
        buy_event, _ = post_event(
            seeded_db,
            second.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="pytest",
        )
        order_event, _ = post_event(
            seeded_db,
            second.id,
            event_type="SELL",
            amount="150.00",
            occurred_on=D,
            actor="pytest",
            offset_event_id=buy_event.id,
        )

        with pytest.raises(Validation) as exc:
            post_event(
                seeded_db,
                first.id,
                event_type="CANCEL",
                amount="10.00",
                occurred_on=D,
                actor="pytest",
                offset_event_id=order_event.id,
                reason="跨订单冲销测试",
            )

        assert exc.value.code == ErrorCode.VALIDATION_ERROR
        assert "同一订单" in str(exc.value)


class TestAccountEffect:
    def test_event_updates_account_operator(self, seeded_db):
        account = Account(
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)

        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="500.00",
            occurred_on=D,
            actor="buyer",
        )

        assert account.updated_by == "buyer"

    def test_cancel_reverses_cost_and_voids_account(self, seeded_db):
        account = Account(
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        buy, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        assert account.cost_amount == 500
        assert account.status == AccountStatus.WAITING.value

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="500.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="回收退回",
        )
        assert account.cost_amount == 0
        assert account.status == AccountStatus.VOID.value

    def test_partial_buy_cancel_keeps_account_in_stock(self, seeded_db):
        account = Account(
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        buy, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="100.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退回",
        )

        assert account.cost_amount == Decimal("400.00")
        assert account.status == AccountStatus.WAITING.value

    def test_cancel_sell_restores_stock_without_reducing_cost(self, seeded_db):
        account = Account(
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        sell, _ = post_event(
            seeded_db, order.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="pytest",
        )
        assert account.status == AccountStatus.SOLD.value

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="800.00",
            occurred_on=D, actor="pytest", offset_event_id=sell.id,
            reason="售出撤销",
        )

        assert account.cost_amount == Decimal("500.00")
        assert account.status == AccountStatus.WAITING.value

    def test_cancel_pickup_sell_returns_to_inventory(self, seeded_db):
        account = Account(
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, order_type="TH", account_id=account.id)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1.00",
            occurred_on=D, actor="pytest", pool_id=1,
        )
        sell, _ = post_event(
            seeded_db, order.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="pytest", pool_id=2,
        )

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="800.00",
            occurred_on=D, actor="pytest", offset_event_id=sell.id,
            reason="提号售出撤销",
        )

        assert account.status == AccountStatus.WAITING.value

    def test_removed_payment_event_is_rejected(self, seeded_db):
        order = _order(seeded_db, order_type="TH")
        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="PAYMENT",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
            )


class TestPoolBalance:
    def test_pool_balance_service_enforces_pool_visibility(self, seeded_db):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )

        with pytest.raises(NotFound):
            pool_balance(seeded_db, 2, user=scoped)

    def test_pool_balance_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            pool_balance(seeded_db, 999999)


