"""orders 订单/事件契约测试（ORD-01/02、FIN-01/03）。

与 test_orders.py / test_bughunt.py / test_m2.py 的分工：既有文件已覆盖四类业务建单、
BUY/COST/SELL/PAYMENT/DELIVER/CANCEL(无 offset) 过账、状态机、路由缺失等主路径；
本文件补NotFound/越权/过滤/非法入参分支、`_opposite_direction` 三分支、
`_apply_account_effect` 防御与 CANCEL 分支、以及 3 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import AccountStatus, CapitalType, OrderStatus
from app.parties import service as parties_service
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.foundation import service as foundation_service
from app.orders import service as order_service

D = date(2026, 10, 4)


def _order(seeded_db, *, order_type="HS", account_id=None, owner_id=None, trade_date=D):
    return order_service.create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
    )


def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )


# ------------------------------------------------------------------ 建单校验
class TestCreateOrderValidation:
    def test_order_commission_fields_are_closed_at_database_boundary(self, seeded_db):
        order = _order(seeded_db, order_type="DG")
        order.commission_mode = "UNKNOWN"
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_event_delivery_mode_is_closed_at_database_boundary(self, seeded_db):
        order = _order(seeded_db)
        seeded_db.add(
            OrderEvent(
                event_no="HS-DB-DELIVERY",
                order_id=order.id,
                event_type="BUY",
                amount=Decimal("0"),
                portion="GROSS",
                occurred_on=D,
                delivery_mode="UNKNOWN",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_order_link_status_is_closed_at_database_boundary(self, seeded_db):
        seeded_db.add(
            Order(
                order_no="HS-INVALID-LINK-STATUS",
                order_type="HS",
                capital_type=CapitalType.STOCK.value,
                trade_date=D,
                status=OrderStatus.ACTIVE.value,
                link_status="AUTO_MATCHED",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_order_amounts_cannot_be_negative_in_database(self, seeded_db):
        seeded_db.add(
            Order(
                order_no="HS-NEGATIVE-AMOUNT",
                order_type="HS",
                capital_type=CapitalType.STOCK.value,
                trade_date=D,
                listing_price=Decimal("-1"),
                status=OrderStatus.ACTIVE.value,
                link_status="LINKED",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_unknown_order_type_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            order_service.create_order(
                seeded_db, order_type="ZZ", trade_date=D, actor="pytest"
            )
        assert "不存在" in str(exc.value)

    def test_invalid_capital_type_rejected_before_database_constraint(self, seeded_db):
        with pytest.raises(Validation, match="capital_type"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                capital_type="NOT_A_CAPITAL_TYPE",
            )

    def test_duplicate_participant_role_rejected_before_unique_constraint(
        self, seeded_db
    ):
        customer = parties_service.create_customer(
            seeded_db, display_name="重复角色客户", actor="pytest"
        )
        with pytest.raises(Validation, match="不可重复"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                customer_roles=[
                    (customer.id, "SELLER"),
                    (customer.id, "SELLER"),
                ],
            )

    def test_disabled_order_type_rejected(self, seeded_db):
        definition = foundation_service.get_order_type_by_code(seeded_db, "HS")
        foundation_service.set_order_type_active(
            seeded_db, definition.id, False, actor="pytest"
        )
        with pytest.raises(Validation) as exc:
            _order(seeded_db)
        assert "已停用" in str(exc.value)

    def test_dfq_cannot_link_inventory_account(self, seeded_db):
        account = Account(
            inventory_no="ACC-DFQ-1",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation) as exc:
            _order(seeded_db, order_type="DFQ", account_id=account.id)

        assert "DFQ 代分期订单不关联库存账号" in str(exc.value)

    def test_order_rejects_mismatched_existing_account_context(self, seeded_db):
        account = Account(
            inventory_no="ACC-WRONG-CONTEXT",
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation, match="库存账号业务类型与订单类型不匹配"):
            _order(seeded_db, order_type="DG", account_id=account.id)

    def test_scoped_user_cannot_attach_foreign_account(self, seeded_db):
        account = Account(
            inventory_no="ACC-SCOPE-1",
            game_account="scope-account",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="another-operator",
            updated_by="another-operator",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(NotFound):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="operator",
                account_id=account.id,
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_attach_foreign_customer(self, seeded_db):
        customer = parties_service.create_customer(
            seeded_db,
            display_name="foreign-customer",
            actor="another-operator",
            owner_id=8,
        )

        with pytest.raises(NotFound):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="operator",
                customer_roles=[(customer.id, "SELLER")],
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_assign_order_to_other_owner_in_service(
        self, seeded_db
    ):
        order = order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="operator",
            owner_id=1,
            user=_scoped_user(),
        )
        assert order.owner_id == 9

    def test_dg_commission_terms_are_persisted(self, seeded_db):
        order = order_service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=D,
            actor="pytest",
            listing_price="1200.00",
            service_fee="120.00",
            commission_mode="DEDUCT_FROM_SETTLEMENT",
            commission_payer="CONSIGNOR",
            expected_settlement_date=date(2026, 10, 20),
        )

        assert order.listing_price == Decimal("1200.00")
        assert order.service_fee == Decimal("120.00")
        assert order.commission_mode == "DEDUCT_FROM_SETTLEMENT"
        assert order.commission_payer == "CONSIGNOR"
        assert order.expected_settlement_date == date(2026, 10, 20)

    def test_dg_service_fee_cannot_exceed_listing_price(self, seeded_db):
        with pytest.raises(Validation, match="服务费不能超过挂售价"):
            order_service.create_order(
                seeded_db,
                order_type="DG",
                trade_date=D,
                actor="pytest",
                listing_price="100.00",
                service_fee="100.01",
            )

    def test_dfq_account_snapshot_does_not_create_inventory_account(self, seeded_db):
        order = order_service.create_order(
            seeded_db,
            order_type="DFQ",
            trade_date=D,
            actor="pytest",
            account_snapshot={
                "game_type": "王者荣耀",
                "game_account": "dfq-text-account",
                "game_password": "secret",
                "channel_region": "安卓一区",
                "note": "仅订单文本",
            },
        )

        assert order.account_id is None
        assert order.account_snapshot["game_account"] == "dfq-text-account"
        assert seeded_db.scalar(
            select(Account.id).where(Account.game_account == "dfq-text-account")
        ) is None

    def test_dfq_account_snapshot_rejects_unknown_fields(self, seeded_db):
        with pytest.raises(Validation, match="订单账号快照字段校验失败"):
            order_service.create_order(
                seeded_db,
                order_type="DFQ",
                trade_date=D,
                actor="pytest",
                account_snapshot={
                    "game_account": "dfq-invalid-snapshot",
                    "account_note": "不属于订单账号文本字段",
                },
            )


# ------------------------------------------------------------------ 查询与作用域
class TestGetAndListOrders:
    def test_get_order_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            order_service.get_order(seeded_db, 999999)

    def test_active_order_can_update_note_before_posting(self, seeded_db):
        order = _order(seeded_db)
        updated = order_service.update_order(
            seeded_db, order.id, actor="operator", note="补充客户备注"
        )
        assert updated.note == "补充客户备注"

    def test_posted_order_cannot_update_accounting_fields_but_can_update_note(
        self, seeded_db
    ):
        order = _order(seeded_db, order_type="DG")
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("200"),
            occurred_on=D,
            actor="pytest",
            portion="GROSS",
        )
        with pytest.raises(Validation, match="过账事件"):
            order_service.update_order(
                seeded_db, order.id, actor="operator", listing_price=Decimal("300")
            )
        updated = order_service.update_order(
            seeded_db, order.id, actor="operator", note="仅改备注"
        )
        assert updated.note == "仅改备注"

    def test_order_cancel_requires_no_posted_events(self, seeded_db):
        order = _order(seeded_db)
        cancelled = order_service.cancel_order(
            seeded_db, order.id, actor="operator", reason="客户撤单"
        )
        assert cancelled.status == "CANCELLED"

        posted = _order(seeded_db)
        order_service.post_event(
            seeded_db, posted.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=D, actor="pytest"
        )
        with pytest.raises(Validation, match="过账事件"):
            order_service.cancel_order(
                seeded_db, posted.id, actor="operator", reason="不能直接作废"
            )

    def test_get_order_owner_scope_forbidden(self, seeded_db):
        # 他人 owner 的订单对 SELF 作用域用户同样 404（不泄露存在性）
        order = _order(seeded_db, owner_id=1)
        with pytest.raises(NotFound):
            order_service.get_order(seeded_db, order.id, _scoped_user())

    def test_scoped_user_cannot_post_event_to_foreign_order(self, seeded_db):
        order = _order(seeded_db, owner_id=1)
        with pytest.raises(NotFound):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("10"),
                occurred_on=D,
                actor="operator",
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_post_event_to_foreign_pool(self, seeded_db):
        order = _order(seeded_db, owner_id=9)
        scoped = CurrentUser.build(
            id=9,
            username="operator",
            roles=["OPERATOR"],
            owner_scope="SELF",
            pool_ids=frozenset({2}),
        )
        with pytest.raises(NotFound):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("10"),
                occurred_on=D,
                actor="operator",
                pool_id=1,
                user=scoped,
            )

    def test_list_orders_filters_and_scope(self, seeded_db):
        mine = _order(seeded_db, owner_id=9)
        _order(seeded_db, order_type="TH", owner_id=1)
        order_service.post_event(
            seeded_db, mine.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )

        by_type = order_service.list_orders(seeded_db, order_type="HS")
        assert [o.id for o in by_type] == [mine.id]
        by_status = order_service.list_orders(seeded_db, status="ACTIVE")
        assert mine.id in [o.id for o in by_status]  # 创建即 ACTIVE，过账不翻转状态

        scoped = order_service.list_orders(seeded_db, user=_scoped_user())
        assert [o.id for o in scoped] == [mine.id]
        # 无 user 不过滤：两张单都可见
        assert len(order_service.list_orders(seeded_db)) == 2


# ------------------------------------------------------------------ 事件入参
class TestPostEventValidation:
    def test_invalid_portion_rejected_before_event_write(self, seeded_db):
        order = _order(seeded_db)

        with pytest.raises(Validation, match="portion"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
                portion="INVALID",
            )

        assert not seeded_db.scalar(
            select(OrderEvent.id).where(OrderEvent.order_id == order.id)
        )

    def test_invalid_cost_category_leaves_no_event_or_cashflow(self, seeded_db):
        order = _order(seeded_db)

        with pytest.raises(Validation):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="COST",
                amount="10.00",
                occurred_on=D,
                actor="pytest",
                flow_category="INVALID",
            )

        assert seeded_db.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all() == []
        assert seeded_db.scalars(
            select(Cashflow).where(Cashflow.order_id == order.id)
        ).all() == []

    def test_invalid_event_type_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="BOGUS", amount="1.00",
                occurred_on=D, actor="pytest",
            )
        assert "事件类型" in str(exc.value)

    def test_transfer_removed_from_event_types(self, seeded_db):
        """划转已从 EventType 移除：不再是「可枚举但不可过账」，而是非法事件类型。"""
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="TRANSFER", amount="1.00",
                occurred_on=D, actor="pytest",
            )
        assert "事件类型" in str(exc.value)

    def test_deliver_requires_note(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="DELIVER",
                occurred_on=D, actor="pytest", delivery_mode="CUSTOMER_SELF",
            )
        assert "凭证" in str(exc.value)

    def test_post_event_to_inactive_pool_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(NotFound):
            order_service.post_event(
                seeded_db, order.id, event_type="BUY", amount="1.00",
                occurred_on=D, actor="pytest", pool_id=999999,
            )


# ------------------------------------------------------------------ 冲销方向
class TestCancelOffsetDirection:
    def test_opposite_direction_three_branches(self, seeded_db):
        from sqlalchemy import select

        from app.domain.enums import Direction
        from app.domain.trade import Cashflow

        # 分支一：无 offset → 默认 IN（CANCEL 后订单即 CANCELLED，每分支独立建单）
        order_a = _order(seeded_db)
        _, _ = order_service.post_event(
            seeded_db, order_a.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        cancel_a, _ = order_service.post_event(
            seeded_db, order_a.id, event_type="CANCEL", amount="10.00",
            occurred_on=D, actor="pytest", reason="撤回部分买入款",
        )
        assert order_a.status == "CANCELLED"

        # 分支二：offset 指向 SELL → 方向取反为 OUT
        order_b = _order(seeded_db, order_type="TH")
        order_service.post_event(
            seeded_db, order_b.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        sell_event, _ = order_service.post_event(
            seeded_db, order_b.id, event_type="SELL", amount="150.00",
            occurred_on=D, actor="pytest",
        )
        cancel_b, _ = order_service.post_event(
            seeded_db, order_b.id, event_type="CANCEL", amount="10.00",
            occurred_on=D, actor="pytest", offset_event_id=sell_event.id,
            reason="买家部分退款",
        )

        # 分支三：offset 指向不存在的事件 → NotFound。FK 全局强制使经 post_event
        # 不可达（INSERT order_events 即失败，校验在 flush 之后），直调私有函数覆盖
        with pytest.raises(NotFound):
            order_service._opposite_direction(999999, seeded_db)

        flows = {
            row.id: row
            for row in seeded_db.scalars(select(Cashflow)).all()
        }
        assert flows[cancel_a.id].direction == Direction.IN.value
        assert flows[cancel_b.id].direction == Direction.OUT.value

    def test_cancel_requires_reason_and_th_offset(self, seeded_db):
        hs = _order(seeded_db)
        order_service.post_event(
            seeded_db, hs.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_reason:
            order_service.post_event(
                seeded_db, hs.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest",
            )
        assert "原因" in str(missing_reason.value)

        th = _order(seeded_db, order_type="TH")
        order_service.post_event(
            seeded_db, th.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_offset:
            order_service.post_event(
                seeded_db, th.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason="同行未付成功",
            )
        assert "offset_event_id" in str(missing_offset.value)

    def test_cancel_cannot_exceed_offset_remaining_or_change_pool(self, seeded_db):
        order = _order(seeded_db, order_type="TH")
        buy, _ = order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest", pool_id=1,
        )

        with pytest.raises(Validation) as wrong_pool:
            order_service.post_event(
                seeded_db, order.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                pool_id=2, reason="资金池更正",
            )
        assert "资金池" in str(wrong_pool.value)

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="60.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退款",
        )
        assert order.status == OrderStatus.ACTIVE.value
        with pytest.raises(Validation) as over_cancel:
            order_service.post_event(
                seeded_db, order.id, event_type="CANCEL", amount="50.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                reason="再次退款",
            )
        assert "剩余可冲销" in str(over_cancel.value)

    def test_cancel_offset_must_belong_to_the_same_order(self, seeded_db):
        first = _order(seeded_db)
        second = _order(seeded_db, order_type="TH")
        order_service.post_event(
            seeded_db,
            second.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="pytest",
        )
        order_event, _ = order_service.post_event(
            seeded_db,
            second.id,
            event_type="SELL",
            amount="150.00",
            occurred_on=D,
            actor="pytest",
        )

        with pytest.raises(Validation) as exc:
            order_service.post_event(
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


# ------------------------------------------------------------------ 账号效果
class TestAccountEffect:
    def test_cancel_reverses_cost_and_voids_account(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-1",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        assert account.cost_amount == 500
        assert account.status == AccountStatus.IN_STOCK.value

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="500.00",
            occurred_on=D, actor="pytest", reason="回收退回",
        )
        assert account.cost_amount == 0
        assert account.status == AccountStatus.VOID.value

    def test_partial_buy_cancel_keeps_account_in_stock(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-PARTIAL",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        buy, _ = order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="100.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退回",
        )

        assert account.cost_amount == Decimal("400.00")
        assert account.status == AccountStatus.IN_STOCK.value

    def test_cancel_sell_restores_stock_without_reducing_cost(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-SELL-CANCEL",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, order_type="TH", account_id=account.id)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        sell, _ = order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="pytest",
        )
        assert account.status == AccountStatus.SOLD.value

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="800.00",
            occurred_on=D, actor="pytest", offset_event_id=sell.id,
            reason="售出撤销",
        )

        assert account.cost_amount == Decimal("500.00")
        assert account.status == AccountStatus.IN_STOCK.value

    def test_cancel_payment_is_rejected_until_schedule_reversal_is_supported(self, seeded_db):
        order = _order(seeded_db, order_type="HS")
        contract = Installment(
            inst_no="FQ-CANCEL-PAYMENT",
            order_id=order.id,
            contract_type="STOCK_SALE",
            principal=to_money("1000"),
            down_payment=to_money("0"),
            service_fee=to_money("0"),
            periods=1,
            per_period_service_fee=to_money("0"),
            per_period=to_money("1000"),
            paid_amount=to_money("0"),
            status="ACTIVE",
        )
        seeded_db.add(contract)
        seeded_db.flush()
        payment, _ = order_service.post_event(
            seeded_db, order.id, event_type="PAYMENT", amount="100.00",
            occurred_on=D, actor="pytest",
        )

        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="CANCEL", amount="100.00",
                occurred_on=D, actor="pytest", offset_event_id=payment.id,
                reason="收款撤销",
            )

        assert "分期" in str(exc.value)

    def test_account_none_branch_is_defensive(self, seeded_db):
        # FK 全局强制使 ORM 路径不可达（账号删除是 SET NULL）；直调私有函数覆盖防御分支
        ghost = Order(
            order_no="HS-GHOST",
            order_type="HS",
            capital_type=CapitalType.STOCK.value,
            trade_date=D,
            status=OrderStatus.ACTIVE.value,
            account_id=999999,
            created_by="pytest",
            updated_by="pytest",
        )
        assert order_service._apply_account_effect(
            seeded_db, ghost, "BUY", Decimal("100")
        ) is None


# ------------------------------------------------------------------ 池余额
class TestPoolBalance:
    def test_pool_balance_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            order_service.pool_balance(seeded_db, 999999)


# ------------------------------------------------------------------ 路由层
class TestOrdersApi:
    def test_order_request_rejects_removed_or_unknown_fields(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "risk_level": "HIGH",
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_order_role_payload_requires_the_matching_participant_id(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "customer_roles": [{"role": "SELLER"}],
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_update_dfq_account_snapshot_uses_order_account_contract(
        self, seeded_client, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "DFQ", "trade_date": D.isoformat()},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        order_id = created.json()["id"]

        invalid = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={"account_snapshot": {"game_type": "王者荣耀"}},
            headers=headers,
        )
        assert invalid.status_code == 422, invalid.text

        unknown = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={
                "account_snapshot": {
                    "game_account": "dfq-edit-account",
                    "unknown_field": "不能静默丢弃",
                }
            },
            headers=headers,
        )
        assert unknown.status_code == 422, unknown.text

        valid = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={
                "account_snapshot": {
                    "game_account": "dfq-edit-account",
                    "game_type": "王者荣耀",
                }
            },
            headers=headers,
        )
        assert valid.status_code == 200, valid.text
        assert valid.json()["account_snapshot"]["game_account"] == "dfq-edit-account"

    def test_update_and_cancel_order_api(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "HS", "trade_date": D.isoformat()},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        order_id = created.json()["id"]

        updated = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={"note": "接口补充备注"},
            headers=headers,
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["note"] == "接口补充备注"

        cancelled = seeded_client.post(
            f"/api/v1/orders/{order_id}/cancel",
            json={"reason": "接口撤单"},
            headers=headers,
        )
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["status"] == "CANCELLED"

    def test_scoped_user_cannot_choose_foreign_pool_for_composite_dfq(
        self, seeded_client, seeded_db
    ):
        user = CurrentUser.build(
            id=9,
            username="operator",
            roles=["OPERATOR"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        headers = {"Authorization": f"Bearer {build_access_token(user)}"}
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "initial_buy": {
                    "amount": "800.00",
                    "occurred_on": D.isoformat(),
                    "pool_id": 2,
                    "portion": "PRINCIPAL",
                },
                "installment": {
                    "contract_type": "ADVANCE_PURCHASE",
                    "principal": "800.00",
                    "periods": 1,
                    "first_due_on": "2026-11-01",
                    "per_period": "800.00",
                },
            },
            headers=headers,
        )
        assert response.status_code == 404, response.text

    def test_scoped_user_cannot_assign_created_order_to_other_owner(
        self, seeded_client, seeded_db
    ):
        from app.core.security import build_access_token

        user = _scoped_user()
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "owner_id": 1,
            },
            headers=scoped_headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["owner_id"] == user.id

    def test_order_creation_persists_embedded_inventory_account(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "account": {
                    "game_account": "embedded-account",
                    "game_type": "王者荣耀",
                    "game_password": "secret",
                    "channel_region": "安卓一区",
                    "bound_phone": "13800000000",
                    "has_secondary": True,
                    "account_description": "订单内建档",
                    "account_images": ["data:image/png;base64,one"],
                    "note": "随订单创建",
                },
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        payload = response.json()
        account = seeded_db.get(Account, payload["account_id"])
        assert account is not None
        assert account.game_account == "embedded-account"
        assert account.business_mode == "SELF"
        assert account.inventory_type == "RECOVERY"
        assert account.account_description == "订单内建档"
        assert account.account_images == ["data:image/png;base64,one"]

    def test_dg_creation_returns_settlement_terms(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DG",
                "trade_date": D.isoformat(),
                "listing_price": "1200.00",
                "service_fee": "120.00",
                "commission_mode": "DEDUCT_FROM_SETTLEMENT",
                "commission_payer": "CONSIGNOR",
                "expected_settlement_date": "2026-10-20",
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        assert response.json()["listing_price"] == "1200.00"
        assert response.json()["service_fee"] == "120.00"
        assert response.json()["commission_mode"] == "DEDUCT_FROM_SETTLEMENT"
        assert response.json()["commission_payer"] == "CONSIGNOR"
        assert response.json()["expected_settlement_date"] == "2026-10-20"

    def test_dfq_composite_create_persists_buy_and_installment(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "initial_buy": {
                    "amount": "800.00",
                    "occurred_on": D.isoformat(),
                    "pool_id": 1,
                    "portion": "PRINCIPAL",
                },
                "installment": {
                    "contract_type": "ADVANCE_PURCHASE",
                    "principal": "800.00",
                    "down_payment": "0",
                    "service_fee": "80.00",
                    "periods": 2,
                    "per_period_service_fee": "40.00",
                    "per_period": "440.00",
                    "first_due_on": "2026-11-01",
                    "schedule": [
                        {"period_no": 1, "due_on": "2026-11-01"},
                        {"period_no": 2, "due_on": "2026-12-01"},
                    ],
                },
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        order_id = response.json()["id"]
        assert seeded_db.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order_id,
                OrderEvent.event_type == "BUY",
                OrderEvent.is_posted.is_(True),
            )
        ) is not None
        contract = seeded_db.scalar(
            select(Installment).where(Installment.order_id == order_id)
        )
        assert contract is not None
        assert contract.contract_type == "ADVANCE_PURCHASE"

    def test_embedded_installment_schedule_rejects_unknown_fields(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "installment": {
                    "contract_type": "ADVANCE_PURCHASE",
                    "principal": "800.00",
                    "periods": 1,
                    "first_due_on": "2026-11-01",
                    "schedule": [
                        {
                            "period_no": 1,
                            "due_on": "2026-11-01",
                            "unknown_field": "must be rejected",
                        }
                    ],
                },
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_dfq_composite_create_rolls_back_when_contract_is_invalid(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "note": "atomic-dfq-failure",
                "initial_buy": {
                    "amount": "800.00",
                    "occurred_on": D.isoformat(),
                    "pool_id": 1,
                },
                "installment": {
                    "contract_type": "STOCK_SALE",
                    "principal": "800.00",
                    "periods": 1,
                    "first_due_on": "2026-11-01",
                },
            },
            headers=headers,
        )

        assert response.status_code == 422, response.text
        # 测试夹具将 get_db 替换为只 yield 会话，显式模拟生产依赖的异常回滚。
        seeded_db.rollback()
        assert seeded_db.scalar(
            select(Order.id).where(Order.note == "atomic-dfq-failure")
        ) is None
        assert seeded_db.scalar(
            select(OrderEvent.id).where(OrderEvent.note == "atomic-dfq-failure")
        ) is None

    def test_list_and_get_endpoints(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        listed = seeded_client.get(
            "/api/v1/orders", params={"order_type": "HS", "status": "ACTIVE"},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        assert [item["order_no"] for item in listed.json()] == [order.order_no]

        fetched = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
        assert fetched.status_code == 200
        assert fetched.json()["id"] == order.id

        missing = seeded_client.get("/api/v1/orders/999999", headers=headers)
        assert missing.status_code == 404

    def test_pool_balance_endpoint_scope_forbidden(self, seeded_client, viewer_headers):
        # viewer 有 finance.read 但无池授权 → 越权池返回 404（不泄露存在性）
        response = seeded_client.get("/api/v1/pools/1/balance", headers=viewer_headers)
        assert response.status_code == 404

    def test_pool_balance_endpoint_ok(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/pools/1/balance", headers=headers)
        assert response.status_code == 200, response.text
        assert "available" in response.json()
