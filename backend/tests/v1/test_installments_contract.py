"""installments 分期合约契约测试（ACC-01 / HS-01-06 / DFQ-01）。

与 test_m2.py / test_bughunt.py 的分工：既有文件已覆盖 DFQ 代分期全流程、
HS 分期出售不新增 BUY、超收校验、未结清不可交付、逾期标记主路径；
本文件补建单校验分支（类型/账号/重复/期数/交付方式）、查询与过滤、
收款守卫（DELIVERED 冲突/期次不存在/自动选期/收满防御）、交付守卫
（非法交付方式/空凭证）、逾期升级 ACTIVE→OVERDUE，以及 3 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import (
    DeliveryMode,
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus,
)
from app.domain.trade import Installment, InstallmentSchedule, Order
from app.installments import service as installment_service
from app.orders import service as orders_service

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)


def _account(seeded_db, game_account: str):
    from app.accounts import service as accounts_service

    return accounts_service.create_account(
        seeded_db, game_account=game_account, platform="王者", actor="pytest"
    )


def _order(seeded_db, *, order_type="DFQ", account_id=None, trade_date=TODAY):
    return orders_service.create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id,
    )


def _buy(seeded_db, order_id: int, amount="800"):
    orders_service.post_event(
        seeded_db, order_id, event_type="BUY", amount=Decimal(amount),
        occurred_on=TODAY, actor="pytest",
    )


def _contract(
    seeded_db,
    order_id: int,
    *,
    contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
    down_payment="100",
    periods=2,
    per_period="300",
    first_due_on=TODAY,
    **kwargs,
) -> Installment:
    return installment_service.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type=contract_type,
        principal=Decimal("700"),
        down_payment=Decimal(down_payment),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=first_due_on,
        actor="pytest",
        **kwargs,
    )


# ------------------------------------------------------------------ 建单校验
class TestCreateInstallmentValidation:
    def test_invalid_contract_type_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            _contract(seeded_db, order.id, contract_type="ZZ")
        assert "合约类型" in str(exc.value)

    def test_stock_sale_requires_in_stock_account(self, seeded_db):
        # HS 订单已建但未 BUY：账号虽然已在库，但缺少买入事件 → 拒绝
        account = _account(seeded_db, "inst-pending-acc")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        with pytest.raises(Validation) as exc:
            _contract(
                seeded_db, order.id,
                contract_type=InstallmentContractType.STOCK_SALE.value,
            )
        assert "已在库" in str(exc.value)

    def test_advance_purchase_does_not_require_account(self, seeded_db):
        # DFQ 是独立分销代分期，不关联库存账号。
        order = _order(seeded_db, order_type="DFQ", account_id=None)
        installment = _contract(seeded_db, order.id)
        assert order.account_id is None

    def test_duplicate_contract_conflicts(self, seeded_db):
        order = _order(seeded_db)
        _contract(seeded_db, order.id)
        with pytest.raises(Conflict) as exc:
            _contract(seeded_db, order.id)
        assert "已存在分期合约" in str(exc.value)

    def test_periods_must_be_positive(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            _contract(seeded_db, order.id, periods=0)
        assert "期数必须大于 0" in str(exc.value)

    def test_invalid_delivery_mode_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            _contract(seeded_db, order.id, delivery_mode="BOGUS")
        assert "交付方式" in str(exc.value)

    def test_cancelled_order_cannot_create_contract(self, seeded_db):
        order = _order(seeded_db)
        order.status = "CANCELLED"
        seeded_db.flush()

        with pytest.raises(Conflict) as exc:
            _contract(seeded_db, order.id)

        assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT


# ------------------------------------------------------------------ 查询与过滤
class TestGetAndListInstallments:
    def test_get_installment_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            installment_service.get_installment(seeded_db, 999999)

    def test_list_filters_by_status_and_order(self, seeded_db):
        order_a = _order(seeded_db)
        order_b = _order(seeded_db)
        contract_a = _contract(seeded_db, order_a.id)
        contract_b = _contract(seeded_db, order_b.id)

        by_status = installment_service.list_installments(
            seeded_db, status=InstallmentStatus.PENDING.value
        )
        assert {c.id for c in by_status} == {contract_a.id, contract_b.id}

        by_order = installment_service.list_installments(seeded_db, order_id=order_b.id)
        assert [c.id for c in by_order] == [contract_b.id]
        assert contract_a.id not in [c.id for c in by_order]


# ------------------------------------------------------------------ 收款守卫
class TestPayGuards:
    def _settled_dfq(self, seeded_db, tag: str) -> tuple[Order, Installment]:
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        return order, contract

    def test_pay_on_delivered_contract_conflicts(self, seeded_db):
        order, contract = self._settled_dfq(seeded_db, "paid-delivered")
        installment_service.deliver(
            seeded_db, contract.id, delivery_mode=DeliveryMode.PLATFORM_OPERATOR.value,
            delivered_on=TODAY, note="平台操作换绑凭证", actor="pytest",
        )
        with pytest.raises(Conflict) as exc:
            installment_service.pay(
                seeded_db, contract.id, amount=Decimal("1"), paid_on=TODAY,
                actor="pytest",
            )
        assert "不可收款" in str(exc.value)

    def test_pay_unknown_period_notfound(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1)
        with pytest.raises(NotFound) as exc:
            installment_service.pay(
                seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
                period_no=99, actor="pytest",
            )
        assert "期次" in str(exc.value)

    def test_pay_without_period_auto_picks_first_unpaid(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=2, per_period="300"
        )
        # 未指定期次：按到期日顺序取第一笔未收满 → 期次 0（首付）
        _, first = installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            actor="pytest",
        )
        assert first.period_no == 0
        # 期次 0 收满后自动落到期次 1
        _, second = installment_service.pay(
            seeded_db, contract.id, amount=Decimal("50"), paid_on=TODAY,
            actor="pytest",
        )
        assert second.period_no == 1
        assert second.status == ScheduleStatus.PARTIAL.value

    def test_pick_schedule_all_paid_is_defensive(self, seeded_db):
        # 收满后 remaining_total=0，pay() 在 _pick_schedule 之前即被"超收"拦下；
        # 直调私有函数覆盖"所有期次已收满"防御分支
        _, contract = self._settled_dfq(seeded_db, "allpaid")
        with pytest.raises(Validation) as exc:
            installment_service._pick_schedule(seeded_db, contract, None, TODAY)
        assert "所有期次已收满" in str(exc.value)


# ------------------------------------------------------------------ 交付守卫
class TestDeliverGuards:
    def _settled(self, seeded_db, tag: str) -> Installment:
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        return contract

    def test_deliver_invalid_mode_rejected(self, seeded_db):
        contract = self._settled(seeded_db, "bad-mode")
        with pytest.raises(Validation) as exc:
            installment_service.deliver(
                seeded_db, contract.id, delivery_mode="BOGUS",
                delivered_on=TODAY, note="凭证", actor="pytest",
            )
        assert "交付方式" in str(exc.value)

    def test_deliver_requires_note(self, seeded_db):
        contract = self._settled(seeded_db, "no-note")
        with pytest.raises(Validation) as exc:
            installment_service.deliver(
                seeded_db, contract.id,
                delivery_mode=DeliveryMode.CUSTOMER_SELF.value,
                delivered_on=TODAY, note="", actor="pytest",
            )
        assert "换绑凭证" in str(exc.value)


# ------------------------------------------------------------------ 逾期升级
class TestMarkOverdue:
    def test_overdue_promotes_active_contract(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300",
            first_due_on=PAST,
        )
        # 收过首付 → 合约 ACTIVE（区别于 PENDING 分支）
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        marked = installment_service.mark_overdue(seeded_db, as_of=TODAY)
        assert marked == 1  # 期次 0 已收满不标记；期次 1 到期未收
        refreshed = seeded_db.get(Installment, contract.id)
        assert refreshed.status == InstallmentStatus.OVERDUE.value
        overdue = seeded_db.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.status == ScheduleStatus.OVERDUE.value,
            )
        ).all()
        assert [row.period_no for row in overdue] == [1]


# ------------------------------------------------------------------ 路由层
class TestInstallmentsApi:
    def test_list_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id)
        response = seeded_client.get(
            "/api/v1/installments", params={"status": "PENDING"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert [item["inst_no"] for item in response.json()] == [contract.inst_no]

    def test_deliver_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        response = seeded_client.post(
            f"/api/v1/installments/{contract.id}/deliver",
            json={
                "delivery_mode": "PLATFORM_OPERATOR",
                "delivered_on": TODAY.isoformat(),
                "note": "平台操作换绑凭证",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == InstallmentStatus.DELIVERED.value

    def test_mark_overdue_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        _contract(
            seeded_db, order.id, down_payment="0", periods=2, per_period="300",
            first_due_on=PAST,
        )
        response = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["marked"] == 2
