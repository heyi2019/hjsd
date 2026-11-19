"""ORDER-01 tests/backend/test_orders：订单、事件、现金流派生（A01 / A02 / A03）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.stocks.profile import create_account
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AccountStatus, EventType
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.installments import create as inst_create
from app.installments import recovery as inst_recovery
from app.installments.repayments.pay import pay as inst_pay
from app.orders.create import create_order
from app.orders.events import post_event
from app.customer_center.customers import create_customer, set_customer_status

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)


def _new_account(seeded_db, *, game_account: str = "acc-001") -> Account:
    account = Account(
        game_account=game_account,
        business_mode="SELF" if game_account != "th-stock-acc" else "DISTRIBUTION",
        inventory_type="RECOVERY" if game_account != "th-stock-acc" else "PICKUP",
        status=AccountStatus.WAITING.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(account)
    seeded_db.commit()
    return account

def _customer(seeded_db, name: str = "甲"):
    return create_customer(seeded_db, display_name=name, actor="pytest")

def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool

def _flows(seeded_db, pool_id: int) -> list[Cashflow]:
    return list(
        seeded_db.scalars(
            select(Cashflow).where(Cashflow.pool_id == pool_id).order_by(Cashflow.id)
        ).all()
    )

def _settled_hs_installment(seeded_db):
    account = _new_account(seeded_db, game_account="delivery-account")
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    contract = inst_create.create_installment(
        seeded_db,
        order_id=order.id,
        contract_type="STOCK_SALE",
        principal=Decimal("600"),
        down_payment=Decimal("100"),
        periods=1,
        per_period=Decimal("500"),
        first_due_on=TODAY,
        actor="pytest",
    )
    inst_pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
        period_no=0, actor="pytest",
    )
    inst_pay(
        seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
        period_no=1, actor="pytest",
    )
    return order


def _account(seeded_db, *, game_account: str = "b4-acc", status: str = "WAITING") -> Account:
    acc = Account(
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        status=status,
        stock_no="KU_B4_" + game_account[-4:].upper(),
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(acc)
    seeded_db.commit()
    return acc

def _hs_order(seeded_db, *, account: Account | None = None) -> Order:
    return create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id if account is not None else None,
    )

def _buy(seeded_db, order: Order, *, amount: str = "500", occurred: date = TODAY,
         pool_id: int | None = None):
    return post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal(amount),
        occurred_on=occurred, actor="pytest", pool_id=pool_id,
    )

def _sell(seeded_db, order: Order, *, amount: str = "800", occurred: date = TODAY2,
          pool_id: int | None = None):
    return post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal(amount),
        occurred_on=occurred, actor="pytest", pool_id=pool_id,
    )


class TestEventRules:
    def test_float_event_amount_is_normalized_without_binary_tail(self, seeded_db):
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        event, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount=0.1 + 0.2,
            occurred_on=TODAY, actor="pytest",
        )
        assert str(event.amount) == "0.30"

    def test_negative_event_amount_is_rejected(self, seeded_db):
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        with pytest.raises(Validation):
            post_event(
                seeded_db, order.id, event_type="BUY", amount="-100.00",
                occurred_on=TODAY, actor="pytest",
            )

    def test_zero_buy_amount_is_allowed(self, seeded_db):
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        event, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="0",
            occurred_on=TODAY, actor="pytest",
        )
        assert event.amount == 0

    def test_cancelled_order_rejects_new_event(self, seeded_db):
        from app.orders.cancellation_model import cancel_order

        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        cancel_order(seeded_db, order.id, actor="pytest", reason="撤销空订单")
        with pytest.raises(Conflict):
            post_event(
                seeded_db, order.id, event_type="BUY", amount="100",
                occurred_on=TODAY, actor="pytest",
            )

    def test_pickup_sale_requires_prior_purchase(self, seeded_db):
        account = create_account(
            seeded_db, game_account="pickup-sale-before-buy",
            business_mode="DISTRIBUTION", inventory_type="PICKUP", actor="pytest",
        )
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id,
        )
        with pytest.raises(Validation, match="BUY"):
            post_event(
                seeded_db, order.id, event_type="SELL", amount="1200",
                occurred_on=TODAY, actor="pytest", pool_id=1,
            )

    def test_disabled_pool_rejects_new_order_event(self, seeded_db):
        from app.field_definitions.pools import set_pool_status

        set_pool_status(seeded_db, 1, "DISABLED", actor="pytest")
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        with pytest.raises(Validation):
            post_event(
                seeded_db, order.id, event_type="BUY", amount="100",
                occurred_on=TODAY, actor="pytest", pool_id=1,
            )

    @pytest.mark.parametrize(("order_type", "inventory_type"), [("HS", "RECOVERY"), ("TH", "PICKUP")])
    def test_inline_purchase_creates_inventory(self, seeded_db, order_type, inventory_type):
        """2026-10-28 口径：建单成功即内联建库存账号（编号已发放），BUY 只累计成本。"""
        order = create_order(
            seeded_db,
            order_type=order_type,
            trade_date=TODAY,
            actor="pytest",
            account_snapshot={"game_account": "inline-recovery-account"},
        )

        assert order.account_id is not None
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        assert account.game_account == "inline-recovery-account"
        assert account.inventory_type == inventory_type
        assert account.status == "WAITING"
        assert account.cost_amount == Decimal("0.00")

        event, _ = post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )

        assert event.event_type == "BUY"
        assert account.cost_amount == Decimal("100.00")
        assert account.buy_date == TODAY
        assert account.status == "WAITING"

    def test_inline_consignment_creates_inventory(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest",
            account_snapshot={"game_account": "inline-consignment-account"},
        )
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        assert account.inventory_type == "CONSIGNMENT"
        assert account.status == "WAITING"
        assert account.cost_amount == Decimal("0.00")

    def test_dg_cannot_post_buy(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation, match="代挂业务不允许 BUY"):
            post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_cost_is_not_a_th_event(self, seeded_db):
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="COST",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_hs_cannot_add_removed_cost_event_after_account_is_sold(self, seeded_db):
        account = _new_account(seeded_db, game_account="sold-cost-guard")
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )
        post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("150"),
            occurred_on=TODAY,
            actor="pytest",
        )

        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="COST",
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_th_sell_requires_a_buy(self, seeded_db):
        account = _new_account(seeded_db, game_account="th-stock-acc")
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id
        )

        with pytest.raises(Validation) as exc:
            post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

        assert "BUY" in str(exc.value)

    def test_th_order_accepts_only_one_sell_event(self, seeded_db):
        account = _new_account(seeded_db, game_account="th-stock-acc")
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        buy, _ = post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )
        post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("120"),
            occurred_on=TODAY,
            actor="pytest",
        )

        with pytest.raises(Validation, match="只能登记一次 SELL"):
            post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="pytest",
                offset_event_id=buy.id,
            )

    def test_payment_event_is_removed(self, seeded_db):
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="PAYMENT",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_unknown_account_is_rejected_before_database_flush(self, seeded_db):
        with pytest.raises(NotFound) as exc:
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                account_id=999999,
            )

        assert exc.value.details == {"account_id": 999999}

    def test_invalid_participant_roles_are_rejected_before_database_flush(self, seeded_db):
        customer = _customer(seeded_db)
        with pytest.raises(Validation) as exc:
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                customer_roles=[(customer.id, "INVALID")],
            )

        assert exc.value.code == ErrorCode.PARTICIPANT_ROLE_INVALID

    def test_deliver_generates_no_cashflow(self, seeded_db):
        order = _settled_hs_installment(seeded_db)
        contract = seeded_db.scalar(
            select(Installment).where(Installment.order_id == order.id)
        )
        assert contract is not None
        inst_recovery.deliver(
            seeded_db,
            contract.id,
            delivered_on=TODAY,
            note="客户自行换绑凭证",
            actor="pytest",
        )
        event = seeded_db.scalar(
            select(OrderEvent)
            .where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.DELIVER.value,
            )
            .order_by(OrderEvent.id.desc())
        )
        flow = None
        assert event is not None
        seeded_db.commit()
        assert flow is None
        assert event.amount == Decimal("0.00")
        assert seeded_db.scalar(
            select(Cashflow).where(
                Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
            )
        ) is None

    def test_full_sale_can_record_sell_delivery_without_cashflow(self, seeded_db):
        account = _new_account(seeded_db, game_account="full-sale-delivery")
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest",
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("200"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )
        event, flow = post_event(
            seeded_db,
            order.id,
            event_type="DELIVER",
            delivery_direction="SELL",
            occurred_on=TODAY,
            actor="pytest",
            note="客户自行换绑凭证",
        )
        assert event.event_type == EventType.DELIVER.value
        assert event.form_extra["delivery_direction"] == "SELL"
        assert flow is None
        assert seeded_db.scalar(
            select(Cashflow).where(
                Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
            )
        ) is None

    def test_dg_sale_can_record_sell_delivery_without_buy(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("200"),
            occurred_on=TODAY, actor="pytest", portion="GROSS",
        )
        event, flow = post_event(
            seeded_db,
            order.id,
            event_type="DELIVER",
            delivery_direction="SELL",
            occurred_on=TODAY,
            actor="pytest",
            note="代挂订单交付凭证",
        )
        assert event.form_extra["delivery_direction"] == "SELL"
        assert flow is None

    def test_direct_deliver_event_cannot_bypass_installment_service(self, seeded_db):
        order = _settled_hs_installment(seeded_db)
        with pytest.raises(Exception, match="分期交付流程"):
            post_event(
                seeded_db,
                order.id,
                event_type=EventType.DELIVER.value,
                occurred_on=TODAY,
                actor="pytest",
                note="客户自行换绑凭证",
            )

    def test_deliver_requires_mode_and_voucher(self, seeded_db):
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            post_event(
                seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest"
            )
        assert exc.value.code == ErrorCode.DELIVERY_CONDITION_UNMET

    def test_missing_route_blocks_posting(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        # DG 是零本金业务，业务事件组合先于资金账户解析拦截 BUY。
        with pytest.raises(Exception) as exc:
            post_event(
                seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
                occurred_on=TODAY, actor="pytest", portion="PRINCIPAL",
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_disabled_participant_rejected(self, seeded_db):
        customer = _customer(seeded_db)
        seeded_db.commit()
        set_customer_status(seeded_db, customer.id, "DISABLED", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                customer_roles=[(customer.id, "SELLER")],
            )
        assert exc.value.code == ErrorCode.CUSTOMER_DISABLED
