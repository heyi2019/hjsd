"""tests/v1/test_m2：账号、分期、押金、返点（A04 / A05 / A06 / A08）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.accounts import service as accounts_service
from app.core.errors import ErrorCode
from app.domain.enums import (
    AccountStatus,
    DepositStatus,
    InstallmentContractType,
    InstallmentStatus,
    OrderStatus,
    ScheduleStatus,
)
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, Installment, InstallmentSchedule, Order
from app.finance import service as finance_service
from app.installments import service as installment_service
from app.orders import service as orders_service
from app.parties import service as parties_service

TODAY = date(2026, 10, 4)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool


def _account(seeded_db, game_account: str):
    return accounts_service.create_account(
        seeded_db, game_account=game_account, platform="王者", actor="pytest"
    )


class TestA04DfqAdvancePurchase:
    def test_buy_downpayment_two_periods_deliver(self, seeded_db):
        account = _account(seeded_db, "dfq-acc")
        supplier = parties_service.create_counterparty(
            seeded_db, display_name="供货方B", type="SUPPLIER", actor="pytest"
        )
        customer = parties_service.create_customer(seeded_db, display_name="分期客户", actor="pytest")
        seeded_db.commit()

        order = orders_service.create_order(
            seeded_db,
            order_type="DFQ",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            customer_roles=[(customer.id, "INSTALLMENT_CUSTOMER")],
            counterparty_roles=[(supplier.id, "SUPPLIER")],
        )
        seeded_db.commit()

        orders_service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()
        assert seeded_db.get(type(account), account.id).status == AccountStatus.INSTALLMENT.value

        contract = installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
            principal=Decimal("1200"),
            down_payment=Decimal("200"),
            periods=2,
            per_period=Decimal("500"),
            first_due_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        assert installment_service.total_receivable(contract) == Decimal("1200.00")

        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("200"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=2, actor="pytest",
        )
        seeded_db.commit()

        contract = seeded_db.get(Installment, contract.id)
        assert contract.paid_amount == Decimal("1200.00")
        assert contract.status == InstallmentStatus.SETTLED.value

        flows_before = seeded_db.scalar(select(Cashflow).where(Cashflow.id > 0)) is not None
        assert flows_before

        installment_service.deliver(
            seeded_db, contract.id, delivery_mode="PLATFORM_OPERATOR",
            delivered_on=TODAY, note="平台操作换绑凭证IMG_02", actor="pytest",
        )
        seeded_db.commit()
        contract = seeded_db.get(Installment, contract.id)
        assert contract.status == InstallmentStatus.DELIVERED.value
        assert seeded_db.get(Order, order.id).status == OrderStatus.COMPLETED.value
        # DELIVER 不新增现金流
        deliver_flows = seeded_db.scalars(
            select(Cashflow).where(Cashflow.category == "PAYMENT")
        ).all()
        assert len(deliver_flows) == 3  # 首付 + 两期

    def test_unsettled_contract_cannot_deliver(self, seeded_db):
        account = _account(seeded_db, "dfq-acc2")
        seeded_db.commit()
        order = orders_service.create_order(
            seeded_db, order_type="DFQ", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        contract = installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
            down_payment=Decimal("100"),
            periods=2,
            per_period=Decimal("500"),
            first_due_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            installment_service.deliver(
                seeded_db, contract.id, delivery_mode="CUSTOMER_SELF",
                delivered_on=TODAY, note="凭证", actor="pytest",
            )
        assert exc.value.code == ErrorCode.DELIVERY_CONDITION_UNMET

    def test_payment_cannot_exceed_receivable(self, seeded_db):
        account = _account(seeded_db, "dfq-acc3")
        seeded_db.commit()
        order = orders_service.create_order(
            seeded_db, order_type="DFQ", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        contract = installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
            down_payment=Decimal("100"),
            periods=1,
            per_period=Decimal("500"),
            first_due_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            installment_service.pay(
                seeded_db, contract.id, amount=Decimal("600"), paid_on=TODAY,
                period_no=1, actor="pytest",
            )
        assert exc.value.code == ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE


class TestA05HsStockSale:
    def test_stock_sale_contract_adds_no_new_buy(self, seeded_db):
        account = _account(seeded_db, "hs-acc")
        seeded_db.commit()
        order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        orders_service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("800"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()
        assert seeded_db.get(type(account), account.id).status == AccountStatus.IN_STOCK.value

        invest = _pool(seeded_db, "HJ_INVEST")
        contract = installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal=Decimal("1100"),
            down_payment=Decimal("100"),
            periods=2,
            per_period=Decimal("500"),
            first_due_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()

        # 创建合约不新增 BUY 支出
        buys = seeded_db.scalars(
            select(Cashflow).where(
                Cashflow.category == "BUY", Cashflow.pool_id == invest.id
            )
        ).all()
        assert len(buys) == 1
        assert str(buys[0].amount) == "800.00"

        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        seeded_db.commit()
        contract = seeded_db.get(Installment, contract.id)
        assert contract.status == InstallmentStatus.ACTIVE.value
        assert contract.paid_amount == Decimal("600.00")

        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=2, actor="pytest",
        )
        seeded_db.commit()
        contract = seeded_db.get(Installment, contract.id)
        assert contract.status == InstallmentStatus.SETTLED.value
        assert seeded_db.get(type(account), account.id).status == AccountStatus.INSTALLMENT.value

        installment_service.deliver(
            seeded_db, contract.id, delivery_mode="CUSTOMER_SELF",
            delivered_on=TODAY, note="客户自行换绑凭证", actor="pytest",
        )
        seeded_db.commit()
        assert seeded_db.get(Installment, contract.id).status == InstallmentStatus.DELIVERED.value

    def test_stock_sale_requires_hs_order(self, seeded_db):
        account = _account(seeded_db, "th-acc")
        seeded_db.commit()
        order = orders_service.create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            installment_service.create_installment(
                seeded_db,
                order_id=order.id,
                contract_type=InstallmentContractType.STOCK_SALE.value,
                periods=1,
                per_period=Decimal("100"),
                first_due_on=TODAY,
                actor="pytest",
            )
        assert exc.value.code == ErrorCode.INSTALLMENT_TYPE_INVALID

    def test_overdue_marking(self, seeded_db):
        account = _account(seeded_db, "hs-acc2")
        seeded_db.commit()
        order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        orders_service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()
        contract = installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            down_payment=Decimal("0"),
            periods=2,
            per_period=Decimal("300"),
            first_due_on=date(2026, 9, 1),
            actor="pytest",
        )
        seeded_db.commit()
        marked = installment_service.mark_overdue(seeded_db, as_of=TODAY)
        seeded_db.commit()
        assert marked == 2
        overdue = seeded_db.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.status == ScheduleStatus.OVERDUE.value,
            )
        ).all()
        assert len(overdue) == 2


class TestA08Deposit:
    def test_deposit_holds_available_balance_without_profit_impact(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        before = orders_service.pool_balance(seeded_db, invest.id)
        deposit = finance_service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("2000"), paid_on=TODAY, actor="pytest"
        )
        seeded_db.commit()
        after = orders_service.pool_balance(seeded_db, invest.id)

        assert deposit.status == DepositStatus.PAID.value
        # 押金流出使现金余额下降，且额外占用可用余额
        assert after["cash_balance"] == before["cash_balance"] - Decimal("2000")
        assert after["deposit_held"] == Decimal("2000.00")
        assert after["available"] == after["cash_balance"] - Decimal("2000")

        # 部分退回
        finance_service.return_deposit(
            seeded_db, deposit.id, amount=Decimal("1200"), released_on=TODAY, actor="pytest"
        )
        seeded_db.commit()
        deposit = seeded_db.get(type(deposit), deposit.id)
        assert deposit.status == DepositStatus.PARTIALLY_RETURNED.value
        assert deposit.returned_amount == Decimal("1200.00")
        balance = orders_service.pool_balance(seeded_db, invest.id)
        assert balance["deposit_held"] == Decimal("800.00")

    def test_return_cannot_exceed_outstanding(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = finance_service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY, actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            finance_service.return_deposit(
                seeded_db, deposit.id, amount=Decimal("1500"), released_on=TODAY, actor="pytest"
            )
        assert exc.value.code == ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE


class TestA06Rebate:
    def test_two_settlements_and_net_amounts(self, seeded_db):
        account = _account(seeded_db, "reb-acc")
        seeded_db.commit()
        order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        orders_service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()

        record = finance_service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            base_amount=Decimal("300"),
            rate=Decimal("0.10"),
            collected_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        assert record.rebate_group_no == "REBHS0001"

        profit = _pool(seeded_db, "HJ_PROFIT")
        first = finance_service.settle_rebate(
            seeded_db, record.id, gross_amount=Decimal("200"),
            platform_fee=Decimal("20"), settled_on=TODAY, pool_id=profit.id, actor="pytest",
        )
        second = finance_service.settle_rebate(
            seeded_db, record.id, gross_amount=Decimal("100"),
            platform_fee=Decimal("10"), settled_on=TODAY, pool_id=profit.id, actor="pytest",
        )
        seeded_db.commit()

        assert first.settlement_no == "REBHS0001-01"
        assert second.settlement_no == "REBHS0001-02"
        assert first.net_amount == Decimal("180.00")
        assert second.net_amount == Decimal("90.00")
        assert finance_service.settled_net_total(seeded_db, record.id) == Decimal("270.00")

    def test_rebate_requires_active_source_order(self, seeded_db):
        order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            finance_service.create_rebate(
                seeded_db,
                source_order_id=order.id,
                base_amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
            )
        assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT


class TestM2Api:
    def test_installment_and_payment_endpoints(self, seeded_client, headers, seeded_db):
        account = seeded_client.post(
            "/api/v1/accounts", json={"game_account": "api-acc", "platform": "王者"},
            headers=headers,
        ).json()
        order = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account_id": account["id"],
            },
            headers=headers,
        ).json()
        seeded_client.post(
            f"/api/v1/orders/{order['id']}/events",
            json={"event_type": "BUY", "amount": "800.00", "occurred_on": TODAY.isoformat()},
            headers=headers,
        )
        contract = seeded_client.post(
            "/api/v1/installments",
            json={
                "order_id": order["id"],
                "contract_type": "STOCK_SALE",
                "principal": "1100",
                "down_payment": "100",
                "periods": 2,
                "per_period": "500",
                "first_due_on": TODAY.isoformat(),
            },
            headers=headers,
        )
        assert contract.status_code == 201
        contract_id = contract.json()["id"]

        paid = seeded_client.post(
            f"/api/v1/installments/{contract_id}/payments",
            json={"amount": "100.00", "paid_on": TODAY.isoformat(), "period_no": 0},
            headers=headers,
        )
        assert paid.status_code == 200
        assert paid.json()["schedule"]["status"] == "PAID"

        schedules = seeded_client.get(
            f"/api/v1/installments/{contract_id}/schedules", headers=headers
        ).json()
        assert len(schedules) == 3  # 首付 + 2 期

    def test_deposit_and_rebate_endpoints(self, seeded_client, headers, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = seeded_client.post(
            "/api/v1/deposits",
            json={"pool_id": invest.id, "amount": "2000.00", "paid_on": TODAY.isoformat()},
            headers=headers,
        )
        assert deposit.status_code == 201
        assert deposit.json()["status"] == "PAID"

        returned = seeded_client.post(
            f"/api/v1/deposits/{deposit.json()['id']}/returns",
            json={"amount": "500.00", "released_on": TODAY.isoformat()},
            headers=headers,
        )
        assert returned.json()["status"] == "PARTIALLY_RETURNED"

    def test_inventory_endpoint(self, seeded_client, headers):
        seeded_client.post(
            "/api/v1/accounts", json={"game_account": "inv-acc", "platform": "王者"},
            headers=headers,
        )
        inventory = seeded_client.get("/api/v1/accounts/inventory", headers=headers).json()
        assert inventory["count"] == 0  # 待收状态不计入库存
