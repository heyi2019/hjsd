"""INSTALLMENT-01 tests/backend/test_m2：账号、分期、押金、返点（A04 / A05 / A06 / A08）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.stocks.profile import create_account
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
from app.finance.deposits import create_deposit, return_deposit
from app.finance.rebates import create_rebate
from app.shared.installment_amounts import total_receivable
from app.installments import create as inst_create
from app.installments import recovery as inst_recovery
from app.installments.repayments.pay import pay as inst_pay
from app.orders.create import create_order
from app.orders.events import post_event
from app.finance.balances import pool_balance
from app.customer_center.counterparties import create_counterparty
from app.customer_center.customers import create_customer

TODAY = date(2026, 10, 4)

def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool

def _account(seeded_db, game_account: str):
    return create_account(
        seeded_db,
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )

class TestA04DistributionInstallmentSale:
    """分销货源的分期出售：回收、提号可选分期出售，代挂售出仅全款。

    原 A04 按「代挂分期」编写；代挂售出收敛为仅全款后，分期链路载体改用提号（TH）。
    """

    def test_downpayment_two_periods_deliver(self, seeded_db):
        platform = create_counterparty(
            seeded_db, display_name="寄售平台B", type="PEER", actor="pytest"
        )
        customer = create_customer(seeded_db, display_name="分期客户", actor="pytest")
        seeded_db.commit()

        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=TODAY,
            actor="pytest",
            customer_roles=[(customer.id, "BUYER")],
            counterparty_roles=[(platform.id, "PEER")],
        )
        seeded_db.commit()

        contract = inst_create.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.PICKUP_SALE.value,
            principal=Decimal("1200"),
            down_payment=Decimal("200"),
            periods=2,
            per_period=Decimal("500"),
            first_due_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        # 分期合约号由业务订单号派生：一个订单只有一个分期合约号。
        assert contract.inst_no == f"{order.order_no}-FQ"
        assert total_receivable(contract) == Decimal("1200.00")

        inst_pay(
            seeded_db, contract.id, amount=Decimal("200"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=2, actor="pytest",
        )
        seeded_db.commit()

        contract = seeded_db.get(Installment, contract.id)
        assert contract.paid_amount == Decimal("1200.00")
        assert contract.status == InstallmentStatus.SETTLED.value

        flows_before = seeded_db.scalar(select(Cashflow).where(Cashflow.id > 0)) is not None
        assert flows_before

        inst_recovery.deliver(
            seeded_db, contract.id, delivery_mode="PLATFORM_OPERATOR",
            delivered_on=TODAY, note="平台操作换绑凭证IMG_02", actor="pytest",
        )
        seeded_db.commit()
        contract = seeded_db.get(Installment, contract.id)
        assert contract.status == InstallmentStatus.DELIVERED.value
        assert seeded_db.get(Order, order.id).status == OrderStatus.COMPLETED.value
        # DELIVER 不新增现金流
        deliver_flows = seeded_db.scalars(
            select(Cashflow).where(Cashflow.category == "INSTALLMENT_PAYMENT")
        ).all()
        assert len(deliver_flows) == 3  # 首付 + 两期

    def test_unsettled_contract_cannot_deliver(self, seeded_db):
        seeded_db.commit()
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        contract = inst_create.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.PICKUP_SALE.value,
            principal=Decimal("1100"),
            down_payment=Decimal("100"),
            periods=2,
            per_period=Decimal("500"),
            first_due_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            inst_recovery.deliver(
                seeded_db, contract.id, delivery_mode="CUSTOMER_SELF",
                delivered_on=TODAY, note="凭证", actor="pytest",
            )
        assert exc.value.code == ErrorCode.DELIVERY_CONDITION_UNMET

    def test_payment_cannot_exceed_receivable(self, seeded_db):
        seeded_db.commit()
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        contract = inst_create.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.PICKUP_SALE.value,
            principal=Decimal("600"),
            down_payment=Decimal("100"),
            periods=1,
            per_period=Decimal("500"),
            first_due_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            inst_pay(
                seeded_db, contract.id, amount=Decimal("600"), paid_on=TODAY,
                period_no=1, actor="pytest",
            )
        assert exc.value.code == ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE

class TestA05HsStockSale:
    def test_stock_sale_contract_adds_no_new_buy(self, seeded_db):
        account = _account(seeded_db, "hs-acc")
        seeded_db.commit()
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("800"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()
        assert seeded_db.get(type(account), account.id).status == AccountStatus.WAITING.value

        invest = _pool(seeded_db, "HJ_INVEST")
        contract = inst_create.create_installment(
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

        # 用户口径：自营分期合约号 = 业务订单号-FQ
        assert contract.inst_no == f"{order.order_no}-FQ"

        # 创建合约不新增 BUY 支出
        buys = seeded_db.scalars(
            select(Cashflow).where(
                Cashflow.category == "BUY", Cashflow.pool_id == invest.id
            )
        ).all()
        assert len(buys) == 1
        assert str(buys[0].amount) == "800.00"

        inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        seeded_db.commit()
        contract = seeded_db.get(Installment, contract.id)
        assert contract.status == InstallmentStatus.ACTIVE.value
        assert contract.paid_amount == Decimal("600.00")

        inst_pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=2, actor="pytest",
        )
        seeded_db.commit()
        contract = seeded_db.get(Installment, contract.id)
        assert contract.status == InstallmentStatus.SETTLED.value
        assert seeded_db.get(type(account), account.id).status == AccountStatus.SOLD.value

        inst_recovery.deliver(
            seeded_db, contract.id, delivery_mode="CUSTOMER_SELF",
            delivered_on=TODAY, note="客户自行换绑凭证", actor="admin",
        )
        seeded_db.commit()
        assert seeded_db.get(Installment, contract.id).status == InstallmentStatus.DELIVERED.value
        assert seeded_db.get(type(account), account.id).updated_by == "admin"

    def test_stock_sale_requires_hs_order(self, seeded_db):
        account = create_account(
            seeded_db,
            game_account="hs-acc-stock-sale",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        seeded_db.commit()
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            inst_create.create_installment(
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
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()
        contract = inst_create.create_installment(
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
        marked = inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
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
        before = pool_balance(seeded_db, invest.id)
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("2000"), paid_on=TODAY, actor="pytest"
        )
        seeded_db.commit()
        after = pool_balance(seeded_db, invest.id)

        assert deposit.status == DepositStatus.PAID.value
        # 押金流出使现金余额下降；available=现金余额，不再二次扣押金占用
        assert after["cash_balance"] == before["cash_balance"] - Decimal("2000")
        assert after["deposit_held"] == Decimal("2000.00")
        assert after["available"] == after["cash_balance"]

        # 部分退回
        return_deposit(
            seeded_db, deposit.id, amount=Decimal("1200"), released_on=TODAY, actor="pytest"
        )
        seeded_db.commit()
        deposit = seeded_db.get(type(deposit), deposit.id)
        assert deposit.status == DepositStatus.PARTIALLY_RETURNED.value
        assert deposit.returned_amount == Decimal("1200.00")
        balance = pool_balance(seeded_db, invest.id)
        assert balance["deposit_held"] == Decimal("800.00")

    def test_return_cannot_exceed_outstanding(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY, actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            return_deposit(
                seeded_db, deposit.id, amount=Decimal("1500"), released_on=TODAY, actor="pytest"
            )
        assert exc.value.code == ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE

class TestA06Rebate:

    def test_rebate_requires_active_source_order(self, seeded_db):
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        # 新规则：订单创建即 ACTIVE；用取消态验证返利仍拒绝非活动来源单。
        order.status = "CANCELLED"
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            create_rebate(
                seeded_db,
                source_order_id=order.id,
                amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
            )
        assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT

class TestM2Api:
    def test_installment_and_payment_endpoints(self, seeded_client, headers, seeded_db):
        account = create_account(
            seeded_db,
            game_account="api-acc",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order_response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account_id": account.id,
            },
            headers=headers,
        )
        assert order_response.status_code == 201, order_response.text
        order = order_response.json()
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

    def test_inventory_endpoint(self, seeded_client, seeded_db, headers):
        account = create_account(
            seeded_db,
            game_account="inv-acc",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account_id": account.id,
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        inventory = seeded_client.get(
            "/api/v1/stocks/inventory/ledger",
            params={"limit": 10, "offset": 0},
            headers=headers,
        ).json()
        assert inventory["total"] == 1
