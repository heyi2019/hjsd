"""API-01 分期查询/收款/交付契约：三个 class 拆出。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.domain.enums import (
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus)
from app.domain.trade import Installment, InstallmentSchedule, Order
from app.funds.installments import _shared as inst__shared
from app.funds.installments import create as inst_create
from app.funds.installments import queries as inst_queries
from app.funds.installments import recovery as inst_recovery
from app.funds.installments.repayments.pay import pay as inst_pay
from app.funds.installments.repayments.pay import _pick_schedule as inst_pick
from app.funds.installments.repayments.waive import waive_schedule as inst_waive
from app.business.create import create_order
from app.business.events import post_event

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)

def _account(seeded_db, game_account: str):
    from app.business.stocks.profile import create_account

    return create_account(
        seeded_db,
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )

def _order(seeded_db, *, order_type="TH", account_id=None, owner_id=None, trade_date=TODAY):
    return create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
    )

def _buy(seeded_db, order_id: int, amount="800"):
    post_event(
        seeded_db, order_id, event_type="BUY", amount=Decimal(amount),
        occurred_on=TODAY, actor="pytest",
    )

def _contract(
    seeded_db,
    order_id: int,
    *,
    contract_type=InstallmentContractType.PICKUP_SALE.value,
    principal=None,
    down_payment="100",
    periods=2,
    per_period="300",
    first_due_on=TODAY,
    **kwargs,
) -> Installment:
    if principal is None:
        principal = str(Decimal(down_payment) + Decimal(per_period) * periods)
    return inst_create.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type=contract_type,
        principal=Decimal(principal),
        down_payment=Decimal(down_payment),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=first_due_on,
        actor="pytest",
        **kwargs,
    )


class TestGetAndListInstallments:
    def test_get_installment_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            inst__shared.get_installment(seeded_db, 999999)

    def test_list_filters_by_status_and_order(self, seeded_db):
        order_a = _order(seeded_db)
        order_b = _order(seeded_db)
        contract_a = _contract(seeded_db, order_a.id)
        contract_b = _contract(seeded_db, order_b.id)

        by_status = inst_queries.list_installments(
            seeded_db, status=InstallmentStatus.PENDING.value
        )
        assert {c.id for c in by_status} == {contract_a.id, contract_b.id}

        by_order = inst_queries.list_installments(seeded_db, order_id=order_b.id)
        assert [c.id for c in by_order] == [contract_b.id]
        assert contract_a.id not in [c.id for c in by_order]


class TestPayGuards:
    def test_payment_failure_does_not_mutate_contract_or_schedule(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300"
        )
        with pytest.raises(NotFound):
            inst_pay(
                seeded_db,
                contract.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                period_no=0,
                pool_id=999999,
                actor="cashier",
            )

        seeded_db.commit()
        seeded_db.refresh(contract)
        schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.period_no == 0,
            )
        )
        assert contract.paid_amount == Decimal("0.00")
        assert contract.status == InstallmentStatus.PENDING.value
        assert contract.updated_by == "pytest"
        assert schedule.received_amount == Decimal("0.00")
        assert schedule.status == ScheduleStatus.PENDING.value

    def test_payment_updates_contract_operator(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id)
        inst_pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=0,
            actor="cashier",
        )
        assert contract.updated_by == "cashier"

    def test_full_waiver_settles_contract_for_delivery(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="100",
            principal="100",
        )

        inst_waive(
            seeded_db,
            contract.id,
            period_no=1,
            amount="100",
            waived_on=TODAY,
            actor="pytest",
            reason="全额减免测试",
        )

        assert contract.status == InstallmentStatus.SETTLED.value
        inst_recovery.deliver(
            seeded_db,
            contract.id,
            delivered_on=TODAY,
            note="全额减免后交付凭证",
            actor="pytest",
        )
        assert contract.status == InstallmentStatus.DELIVERED.value

    def test_payment_amount_is_business_error_in_service(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id)
        with pytest.raises(Validation, match="必须大于 0"):
            inst_pay(
                seeded_db,
                contract.id,
                amount=Decimal("0"),
                paid_on=TODAY,
                actor="pytest",
            )

    def _settled_dg(self, seeded_db, tag: str) -> tuple[Order, Installment]:
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        return order, contract

    def test_pay_on_delivered_contract_conflicts(self, seeded_db):
        order, contract = self._settled_dg(seeded_db, "paid-delivered")
        inst_recovery.deliver(
            seeded_db, contract.id,
            delivered_on=TODAY, note="平台操作换绑凭证", actor="pytest",
        )
        with pytest.raises(Conflict) as exc:
            inst_pay(
                seeded_db, contract.id, amount=Decimal("1"), paid_on=TODAY,
                actor="pytest",
            )
        assert "不可收款" in str(exc.value)

    def test_pay_unknown_period_notfound(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1)
        with pytest.raises(NotFound) as exc:
            inst_pay(
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
        _, first = inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            actor="pytest",
        )
        assert first.period_no == 0
        # 期次 0 收满后自动落到期次 1
        _, second = inst_pay(
            seeded_db, contract.id, amount=Decimal("50"), paid_on=TODAY,
            actor="pytest",
        )
        assert second.period_no == 1
        assert second.status == ScheduleStatus.PARTIAL.value

    def test_pick_schedule_all_paid_is_defensive(self, seeded_db):
        # 收满后 remaining_total=0，pay() 在 _pick_schedule 之前即被"超收"拦下；
        # 直调私有函数覆盖"所有期次已收满"防御分支
        _, contract = self._settled_dg(seeded_db, "allpaid")
        with pytest.raises(Validation) as exc:
            inst_pick(seeded_db, contract, None, TODAY)
        assert "所有期次已收满" in str(exc.value)

# ------------------------------------------------------------------ 交付守卫
class TestDeliverGuards:
    def _settled(self, seeded_db, tag: str) -> Installment:
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        return contract

    def test_delivery_updates_contract_operator(self, seeded_db):
        contract = self._settled(seeded_db, "delivery-operator")
        inst_recovery.deliver(
            seeded_db,
            contract.id,
            delivered_on=TODAY,
            note="交付凭证",
            actor="delivery",
        )
        assert contract.updated_by == "delivery"

    def test_deliver_requires_note(self, seeded_db):
        contract = self._settled(seeded_db, "no-note")
        with pytest.raises(Validation) as exc:
            inst_recovery.deliver(
                seeded_db, contract.id,
                delivered_on=TODAY, note="", actor="pytest",
            )
        assert "换绑凭证" in str(exc.value)


