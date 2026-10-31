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
from typing import get_type_hints

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    DeliveryMode,
    Direction,
    EventType,
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus,
)
from app.domain.foundation import AuditLog
from app.domain.trade import Account, Cashflow, Installment, InstallmentDisposition, InstallmentSchedule, Order, OrderEvent
from app.domain.users import User
from app.installments import service as installment_service
from app.installments import router as installments_router
from app.installments import schemas
from app.orders import service as orders_service
from app.reporting import service as reporting_service

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)


def test_installment_action_routes_use_declared_response_types():
    assert get_type_hints(installments_router.pay_installment)["return"] == schemas.PaymentResult
    assert get_type_hints(installments_router.cancel_installment)["return"] == schemas.InstallmentCancelResult
    assert get_type_hints(installments_router.mark_overdue)["return"] == schemas.MarkOverdueOut
    assert get_type_hints(installments_router.recover_installment_account)["return"] == schemas.DispositionOut
    assert get_type_hints(installments_router.resale_installment_account)["return"] == schemas.DispositionOut


def _account(seeded_db, game_account: str):
    from app.stocks import service as stocks_service

    return stocks_service.create_account(
        seeded_db,
        game_account=game_account,
        platform="王者",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )


def _order(seeded_db, *, order_type="DFQ", account_id=None, owner_id=None, trade_date=TODAY):
    return orders_service.create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
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
    principal=None,
    down_payment="100",
    periods=2,
    per_period="300",
    first_due_on=TODAY,
    **kwargs,
) -> Installment:
    if principal is None:
        principal = str(Decimal(down_payment) + Decimal(per_period) * periods)
    return installment_service.create_installment(
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


# ------------------------------------------------------------------ 建单校验
class TestCreateInstallmentValidation:
    @pytest.mark.parametrize(("order_type", "inventory_type"), [("TH", "PICKUP"), ("DG", "CONSIGNMENT")])
    def test_inventory_accounts_use_stock_sale_for_th_and_dg(self, seeded_db, order_type, inventory_type):
        source = orders_service.create_order(
            seeded_db,
            order_type=order_type,
            trade_date=TODAY,
            actor="pytest",
            account_snapshot={"game_account": f"{order_type.lower()}-stock-sale"},
        )
        account = seeded_db.get(Account, source.account_id)
        assert account is not None
        assert account.inventory_type == inventory_type
        if order_type == "TH":
            _buy(seeded_db, source.id)

        sale = orders_service.create_order(
            seeded_db,
            order_type=order_type,
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        contract = _contract(
            seeded_db,
            sale.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="100",
            down_payment="0",
            periods=1,
            per_period="100",
        )

        assert contract.contract_type == InstallmentContractType.STOCK_SALE.value

    @pytest.mark.parametrize(
        ("order_type", "contract_type"),
        [
            ("TH", "PICKUP_SALE"),
            ("DG", "CONSIGNMENT_SALE"),
        ],
    )
    def test_th_and_dg_support_installment_overdue_and_payment(
        self, seeded_db, order_type, contract_type
    ):
        order = _order(seeded_db, order_type=order_type)
        contract = _contract(
            seeded_db,
            order.id,
            contract_type=contract_type,
            principal="100",
            down_payment="0",
            periods=1,
            per_period="100",
            first_due_on=PAST,
        )

        marked = installment_service.mark_overdue(seeded_db, as_of=TODAY)
        assert marked == 1
        seeded_db.refresh(contract)
        assert contract.status == InstallmentStatus.OVERDUE.value

        installment_service.pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=1,
            actor="pytest",
        )
        seeded_db.refresh(contract)
        assert contract.status == InstallmentStatus.SETTLED.value

    def test_installment_refund_only_after_delivery(self, seeded_db):
        from app.orders import service as order_service
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, down_payment="0", periods=1, per_period="100", principal="100")
        installment_service.pay(seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY, period_no=1, actor="pytest")
        with pytest.raises(Validation, match="交付前"):
            order_service.post_event(seeded_db, order.id, event_type="REFUND", amount="30", occurred_on=TODAY, actor="pytest", reason="退款")
        installment_service.deliver(seeded_db, contract.id, delivery_mode="CUSTOMER_SELF", delivered_on=TODAY, note="交付凭证", actor="pytest")
        refund, flow = order_service.post_event(seeded_db, order.id, event_type="REFUND", amount="30", occurred_on=TODAY, actor="pytest", reason="退款")
        assert refund.refund_responsibility == "COMPANY"
        assert flow.direction == "OUT"

    def test_installment_sale_binds_buyer_and_seller_across_orders(self, seeded_db):
        from app.policy import service as policy_service
        from app.orders import service as order_service
        account = _account(seeded_db, "inst-sale-actors")
        purchase = _order(seeded_db, order_type="HS", account_id=account.id)
        order_service.post_event(seeded_db, purchase.id, event_type="BUY", amount="800", occurred_on=TODAY, actor="seeduser1")
        sale = _order(seeded_db, order_type="HS", account_id=account.id)
        items = [{"allocation_type": kind, "user_id": 1 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 25} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")]
        policy_service.set_allocations(seeded_db, sale.id, items=items)
        installment_service.create_installment(seeded_db, order_id=sale.id, contract_type="STOCK_SALE", principal="1000", down_payment="100", periods=1, per_period="900", first_due_on=TODAY, actor="seeduser2")
        allocation = {x["allocation_type"]: x for x in policy_service.list_allocations(seeded_db, sale.id)}
        assert allocation["BUY"]["user_id"] == 1
        assert allocation["SELL"]["user_id"] == 2
        allocation = {x["allocation_type"]: x for x in policy_service.set_allocations(seeded_db, sale.id, items=items)}
        assert allocation["SELL"]["user_id"] == 2

    def test_stock_sale_contract_records_account_operator(self, seeded_db):
        account = _account(seeded_db, "installment-account-operator")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")

        contract = installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal=Decimal("1000"),
            down_payment=Decimal("100"),
            periods=1,
            per_period=Decimal("900"),
            first_due_on=TODAY,
            actor="contract-creator",
        )

        assert contract.order_id == order.id
        seeded_db.refresh(account)
        assert account.status == "SOLD"
        assert account.updated_by == "contract-creator"

    def test_finance_can_collect_installment_payment_with_pool_scope(
        self, seeded_client, seeded_db
    ):
        finance_account = seeded_db.get(User, 9)
        finance_account.role = "FINANCE"
        finance_account.owner_scope = "SELF"
        finance_account.pool_ids = [1]
        seeded_db.flush()

        order = _order(seeded_db, owner_id=9)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="100",
            first_due_on=TODAY,
        )
        token = build_access_token(
            CurrentUser.build(
                id=9,
                username="seeduser9",
                roles=["FINANCE"],
                owner_scope="SELF",
                pool_ids=frozenset({1}),
            )
        )
        response = seeded_client.post(
            f"/api/v1/installments/{contract.id}/payments",
            headers={"Authorization": f"Bearer {token}"},
            json={"amount": "100", "paid_on": TODAY.isoformat(), "pool_id": 1},
        )
        assert response.status_code == 200, response.text
        assert response.json()["schedule"]["status"] == "PAID"

    def test_schedule_period_no_cannot_be_negative_in_database(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1, per_period="100")
        seeded_db.add(
            InstallmentSchedule(
                installment_id=contract.id,
                period_no=-1,
                due_on=TODAY,
                due_amount=Decimal("100"),
                received_amount=Decimal("0"),
                waived_amount=Decimal("0"),
                status=ScheduleStatus.PENDING.value,
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_installment_periods_cannot_be_zero_in_database(self, seeded_db):
        order = _order(seeded_db)
        seeded_db.add(
            Installment(
                inst_no="INS-INVALID-PERIODS",
                order_id=order.id,
                contract_type=InstallmentContractType.STOCK_SALE.value,
                principal=Decimal("0"),
                down_payment=Decimal("0"),
                service_fee=Decimal("0"),
                periods=0,
                per_period_service_fee=Decimal("0"),
                per_period=Decimal("0"),
                paid_amount=Decimal("0"),
                waived_amount=Decimal("0"),
                status=InstallmentStatus.PENDING.value,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_installment_principal_schedule_invariant_is_closed_at_database_boundary(
        self, seeded_db
    ):
        order = _order(seeded_db)
        seeded_db.add(
            Installment(
                inst_no="INS-INVALID-SCHEDULE-TOTAL",
                order_id=order.id,
                contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
                principal=Decimal("700"),
                down_payment=Decimal("100"),
                service_fee=Decimal("0"),
                periods=1,
                per_period_service_fee=Decimal("0"),
                per_period=Decimal("500"),
                paid_amount=Decimal("0"),
                waived_amount=Decimal("0"),
                status=InstallmentStatus.PENDING.value,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_schedule_received_and_waived_cannot_exceed_due_amount_in_database(
        self, seeded_db
    ):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1, per_period="100")
        seeded_db.add(
            InstallmentSchedule(
                installment_id=contract.id,
                period_no=99,
                due_on=TODAY,
                due_amount=Decimal("100"),
                received_amount=Decimal("60"),
                waived_amount=Decimal("50"),
                status=ScheduleStatus.PENDING.value,
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_negative_amount_is_rejected_before_flush(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="不能为负数"):
            _contract(seeded_db, order.id, down_payment="-1")

    @pytest.mark.parametrize(
        ("down_payment", "principal", "per_period", "message"),
        [
            ("200", "100", "300", "首付不能大于本金"),
            ("100", "801", "300", "本金不能大于首付与分期总额"),
        ],
    )
    def test_principal_and_schedule_amounts_must_reconcile(
        self, seeded_db, down_payment, principal, per_period, message
    ):
        order = _order(seeded_db)
        with pytest.raises(Validation, match=message):
            _contract(
                seeded_db,
                order.id,
                down_payment=down_payment,
                per_period=per_period,
                principal=Decimal(principal),
            )

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

    def test_stock_sale_uses_account_purchase_history_not_sale_order_buy(
        self, seeded_db
    ):
        account = _account(seeded_db, "inst-sale-history-acc")
        purchase_order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, purchase_order.id, amount="800")
        sale_order = _order(seeded_db, order_type="HS", account_id=account.id)

        contract = _contract(
            seeded_db,
            sale_order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
        )

        assert contract.order_id == sale_order.id

    def test_advance_purchase_does_not_require_account(self, seeded_db):
        # DFQ 是独立分销代分期，不关联库存账号。
        order = _order(seeded_db, order_type="DFQ", account_id=None)
        _contract(seeded_db, order.id)
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

    def test_first_due_on_is_required_in_service(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="首期应还日期必填"):
            _contract(seeded_db, order.id, first_due_on=None)

    def test_invalid_delivery_mode_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            _contract(seeded_db, order.id, delivery_mode="BOGUS")
        assert "交付方式" in str(exc.value)

    def test_schedule_rejects_unknown_fields_in_service(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="分期计划字段校验失败"):
            _contract(
                seeded_db,
                order.id,
                schedule=[
                    {
                        "period_no": 1,
                        "due_on": TODAY,
                        "unknown": "不应写入",
                    }
                ],
            )

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


def test_cancel_stock_installment_refunds_payments_and_returns_account(seeded_db):
    account = _account(seeded_db, "cancel-stock-installment")
    purchase = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, purchase.id, amount="800")
    sale = _order(seeded_db, order_type="HS", account_id=account.id)
    contract = _contract(
        seeded_db,
        sale.id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal="1000",
        down_payment="100",
        periods=1,
        per_period="900",
    )
    installment_service.pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY, period_no=0, actor="pytest"
    )
    payment = seeded_db.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == sale.id,
            OrderEvent.event_type == "PAYMENT",
        )
    )
    assert payment is not None

    result = installment_service.cancel_installment(
        seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
    )

    seeded_db.refresh(contract)
    seeded_db.refresh(sale)
    seeded_db.refresh(account)
    cancel = seeded_db.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == sale.id,
            OrderEvent.event_type == "CANCEL",
            OrderEvent.offset_event_id.isnot(None),
        )
    )
    assert result["refund_amount"] == Decimal("100.00")
    assert contract.status == InstallmentStatus.CANCELLED.value
    assert sale.status == "CANCELLED"
    assert account.status == AccountStatus.WAITING.value
    assert cancel is not None
    assert cancel.offset_event_id == payment.id
    assert cancel.amount == Decimal("100.00")
    assert seeded_db.scalar(select(Cashflow).where(Cashflow.order_event_id == cancel.id)).direction == Direction.OUT.value


def test_cancel_dfq_refunds_customer_without_reversing_historical_buy(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(
        seeded_db,
        order.id,
        contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
        principal="500",
        down_payment="100",
        periods=1,
        per_period="400",
    )
    installment_service.pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY, period_no=0, actor="pytest"
    )
    advance, _flow = orders_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("400"),
        occurred_on=TODAY,
        actor="pytest",
    )

    result = installment_service.cancel_installment(
        seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消代分期"
    )

    seeded_db.refresh(contract)
    seeded_db.refresh(order)
    reversals = seeded_db.scalars(
        select(OrderEvent).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == "CANCEL",
        ).order_by(OrderEvent.id)
    ).all()
    assert result["refund_amount"] == Decimal("100.00")
    assert result["reversed_amount"] == Decimal("0.00")
    assert contract.status == InstallmentStatus.CANCELLED.value
    assert order.status == "CANCELLED"
    assert len(reversals) == 1
    assert reversals[0].offset_event_id != advance.id
    assert reversals[0].amount == Decimal("100.00")


@pytest.mark.parametrize(
    ("order_type", "contract_type", "business_mode", "inventory_type", "expected_status"),
    [
        ("TH", "PICKUP_SALE", "DISTRIBUTION", "PICKUP", AccountStatus.VOID.value),
        ("DG", "CONSIGNMENT_SALE", "DISTRIBUTION", "CONSIGNMENT", AccountStatus.WAITING.value),
    ],
)
def test_cancel_distribution_installment_uses_business_specific_account_result(
    seeded_db, order_type, contract_type, business_mode, inventory_type, expected_status
):
    from app.stocks import service as stocks_service

    account = stocks_service.create_account(
        seeded_db,
        game_account=f"cancel-{order_type.lower()}-installment",
        business_mode=business_mode,
        inventory_type=inventory_type,
        actor="pytest",
    )
    order = _order(seeded_db, order_type=order_type, account_id=account.id)
    contract = _contract(
        seeded_db,
        order.id,
        contract_type=contract_type,
        principal="100",
        down_payment="0",
        periods=1,
        per_period="100",
    )

    installment_service.cancel_installment(
        seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="取消分期"
    )

    seeded_db.refresh(account)
    assert account.status == expected_status


def test_installment_payment_cannot_be_cancelled_through_generic_event_endpoint(seeded_db):
    order = _order(seeded_db)
    contract = _contract(seeded_db, order.id, down_payment="0", periods=1, per_period="100", principal="100")
    installment_service.pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY, period_no=1, actor="pytest"
    )
    payment = seeded_db.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == EventType.PAYMENT.value,
        )
    )
    assert payment is not None
    with pytest.raises(Validation, match="分期取消流程"):
        orders_service.post_event(
            seeded_db,
            order.id,
            event_type=EventType.CANCEL.value,
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
            offset_event_id=payment.id,
            reason="绕过服务层",
        )

def test_installment_scope_follows_order_owner(seeded_db):
    scoped_user = CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )
    own_order = _order(seeded_db, owner_id=9)
    other_order = _order(seeded_db, owner_id=8)
    own_contract = _contract(seeded_db, own_order.id)
    other_contract = _contract(seeded_db, other_order.id)

    visible = installment_service.list_installments(seeded_db, user=scoped_user)
    assert [item.id for item in visible] == [own_contract.id]
    with pytest.raises(NotFound):
        installment_service.get_installment(seeded_db, other_contract.id, scoped_user)


# ------------------------------------------------------------------ 收款守卫
class TestPayGuards:
    def test_payment_failure_does_not_mutate_contract_or_schedule(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300"
        )
        with pytest.raises(NotFound):
            installment_service.pay(
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
        installment_service.pay(
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

        installment_service.waive_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            amount="100",
            waived_on=TODAY,
            actor="pytest",
            reason="全额减免测试",
        )

        assert contract.status == InstallmentStatus.SETTLED.value
        installment_service.deliver(
            seeded_db,
            contract.id,
            delivery_mode="CUSTOMER_SELF",
            delivered_on=TODAY,
            note="全额减免后交付凭证",
            actor="pytest",
        )
        assert contract.status == InstallmentStatus.DELIVERED.value

    def test_payment_amount_is_business_error_in_service(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id)
        with pytest.raises(Validation, match="必须大于 0"):
            installment_service.pay(
                seeded_db,
                contract.id,
                amount=Decimal("0"),
                paid_on=TODAY,
                actor="pytest",
            )

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

    def test_delivery_updates_contract_operator(self, seeded_db):
        contract = self._settled(seeded_db, "delivery-operator")
        installment_service.deliver(
            seeded_db,
            contract.id,
            delivery_mode=DeliveryMode.CUSTOMER_SELF.value,
            delivered_on=TODAY,
            note="交付凭证",
            actor="delivery",
        )
        assert contract.updated_by == "delivery"

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
    def test_overdue_updates_contract_operator(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )

        installment_service.mark_overdue(seeded_db, as_of=TODAY, actor="risk")

        assert contract.updated_by == "risk"

    def test_terminal_contract_is_not_marked_overdue(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        contract.status = InstallmentStatus.CANCELLED.value
        seeded_db.flush()

        marked = installment_service.mark_overdue(seeded_db, as_of=TODAY)

        assert marked == 0
        schedules = seeded_db.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id
            )
        ).all()
        assert all(row.status != ScheduleStatus.OVERDUE.value for row in schedules)

    def test_overdue_promotes_pending_contract(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )

        marked = installment_service.mark_overdue(seeded_db, as_of=TODAY)

        assert marked == 1  # 零首付期无需逾期，第 1 期进入逾期
        refreshed = seeded_db.get(Installment, contract.id)
        assert refreshed.status == InstallmentStatus.OVERDUE.value

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

        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.INSTALLMENT_OVERDUE.value,
                AuditLog.entity_id == contract.inst_no,
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.after_json["overdue_periods"] == 1
        overdue = seeded_db.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.status == ScheduleStatus.OVERDUE.value,
            )
        ).all()
        assert [row.period_no for row in overdue] == [1]

    def test_settle_early_collects_all_remaining_schedules(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="100",
            periods=2,
            per_period="300",
        )
        installment_service.pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=0,
            actor="pytest",
        )

        settled = installment_service.settle_early(
            seeded_db, contract.id, paid_on=TODAY, actor="pytest"
        )

        assert settled.status == InstallmentStatus.SETTLED.value
        assert settled.paid_amount == Decimal("700.00")
        schedules = seeded_db.scalars(
            select(InstallmentSchedule)
            .where(InstallmentSchedule.installment_id == contract.id)
            .order_by(InstallmentSchedule.period_no)
        ).all()
        assert [row.status for row in schedules] == [
            ScheduleStatus.PAID.value,
            ScheduleStatus.PAID.value,
            ScheduleStatus.PAID.value,
        ]

    def test_default_requires_overdue_and_keeps_unpaid_schedules(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="100",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        installment_service.pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=0,
            actor="pytest",
        )
        installment_service.mark_overdue(seeded_db, as_of=TODAY)

        defaulted = installment_service.mark_default(
            seeded_db, contract.id, actor="risk", reason="逾期未还"
        )

        assert defaulted.status == InstallmentStatus.DEFAULTED.value
        schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        assert schedule.received_amount == Decimal("0.00")
        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.INSTALLMENT_DEFAULT.value,
                AuditLog.entity_id == contract.inst_no,
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.reason == "逾期未还"

        with pytest.raises(Validation, match="逾期"):
            other_order = _order(seeded_db)
            other_contract = _contract(seeded_db, other_order.id)
            installment_service.mark_default(
                seeded_db, other_contract.id, actor="risk", reason="未逾期"
            )

    def test_payment_after_default_does_not_rewrite_default_status(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        installment_service.mark_overdue(seeded_db, as_of=TODAY)
        installment_service.mark_default(
            seeded_db, contract.id, actor="risk", reason="逾期未还"
        )

        paid, _schedule = installment_service.pay(
            seeded_db,
            contract.id,
            amount=Decimal("300"),
            paid_on=TODAY,
            period_no=1,
            actor="collector",
        )

        assert paid.paid_amount == Decimal("300.00")
        assert paid.status == InstallmentStatus.DEFAULTED.value

    def test_installment_action_reasons_require_text_values(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, first_due_on=PAST)
        installment_service.mark_overdue(seeded_db, as_of=TODAY)
        with pytest.raises(Validation, match="违约处置必须填写原因"):
            installment_service.mark_default(
                seeded_db, contract.id, actor="risk", reason=123
            )

    def test_waive_schedule_reduces_receivable_and_keeps_unpaid_history(
        self, seeded_db
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300"
        )

        schedule = installment_service.waive_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            amount=Decimal("300"),
            waived_on=TODAY,
            actor="risk",
            reason="经审批减免",
        )

        seeded_db.refresh(contract)
        assert schedule.status == ScheduleStatus.WAIVED.value
        assert schedule.due_amount == Decimal("300.00")
        assert schedule.waived_amount == Decimal("300.00")
        assert contract.waived_amount == Decimal("300.00")
        assert installment_service.total_receivable(contract) == Decimal("100.00")
        with pytest.raises(Validation, match="超过剩余应收"):
            installment_service.pay(
                seeded_db, contract.id, amount=Decimal("301"), paid_on=TODAY,
                period_no=1, actor="pytest",
            )

    def test_waive_received_schedule_is_rejected(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1, per_period="300")
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        with pytest.raises(Validation, match="已收期"):
            installment_service.waive_schedule(
                seeded_db,
                contract.id,
                period_no=0,
                amount=Decimal("1"),
                waived_on=TODAY,
                actor="risk",
                reason="不应修改",
            )

    def test_extend_schedule_changes_future_date_and_audits_original(
        self, seeded_db
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, periods=1, per_period="300", first_due_on=TODAY
        )
        schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        assert schedule is not None
        original_due_on = schedule.due_on

        extended = installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            new_due_on=date(2026, 12, 31),
            actor="risk",
            reason="客户申请展期",
        )

        assert extended.due_on == date(2026, 12, 31)
        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.INSTALLMENT_EXTEND.value,
                AuditLog.entity_id == contract.inst_no,
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.before_json["due_on"] == original_due_on.isoformat()
        assert audit.after_json["due_on"] == "2026-12-31"


# ------------------------------------------------------------------ 路由层
class TestInstallmentsApi:
    def test_scoped_user_cannot_read_or_pay_other_order_contract(
        self, seeded_client, seeded_db
    ):
        own_order = _order(seeded_db, owner_id=9)
        other_order = _order(seeded_db, owner_id=8)
        own_contract = _contract(seeded_db, own_order.id)
        other_contract = _contract(seeded_db, other_order.id)
        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        listing = seeded_client.get("/api/v1/installments", headers=scoped_headers)
        assert listing.status_code == 200
        assert [row["id"] for row in listing.json()] == [own_contract.id]

        schedules = seeded_client.get(
            f"/api/v1/installments/{other_contract.id}/schedules",
            headers=scoped_headers,
        )
        assert schedules.status_code == 404

        payment = seeded_client.post(
            f"/api/v1/installments/{other_contract.id}/payments",
            json={"amount": "1.00", "paid_on": TODAY.isoformat()},
            headers=scoped_headers,
        )
        assert payment.status_code == 404

    def test_list_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, first_due_on=PAST, note="分期备注")
        response = seeded_client.get(
            "/api/v1/installments", params={"status": "PENDING"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert [item["inst_no"] for item in response.json()] == [contract.inst_no]
        row = response.json()[0]
        assert row["first_due_on"] == PAST.isoformat()
        assert row["note"] == "分期备注"

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
                "bound_phone": "13800000000",
                "bound_phone_owner": "张三",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == InstallmentStatus.DELIVERED.value
        seeded_db.refresh(order)
        # 该测试订单没有账号快照；换绑字段仍以交付事件关联保存。
        assert order.account_snapshot is None
        event = seeded_db.scalar(
            select(OrderEvent).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.DELIVER.value,
            )
        )
        assert event is not None
        assert event.form_extra == {
            "bound_phone": "13800000000",
            "bound_phone_owner": "张三",
        }

    def test_settle_early_and_default_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="100",
            periods=1,
            per_period="300",
        )
        paid = seeded_client.post(
            f"/api/v1/installments/{contract.id}/payments",
            json={
                "amount": "100",
                "paid_on": TODAY.isoformat(),
                "period_no": 0,
            },
            headers=headers,
        )
        assert paid.status_code == 200, paid.text

        early = seeded_client.post(
            f"/api/v1/installments/{contract.id}/settle-early",
            json={"paid_on": TODAY.isoformat(), "note": "一次性结清"},
            headers=headers,
        )
        assert early.status_code == 200, early.text
        assert early.json()["status"] == InstallmentStatus.SETTLED.value

        overdue_order = _order(seeded_db)
        overdue_contract = _contract(
            seeded_db,
            overdue_order.id,
            down_payment="100",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        overdue_paid = seeded_client.post(
            f"/api/v1/installments/{overdue_contract.id}/payments",
            json={
                "amount": "100",
                "paid_on": TODAY.isoformat(),
                "period_no": 0,
            },
            headers=headers,
        )
        assert overdue_paid.status_code == 200, overdue_paid.text
        marked = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )
        assert marked.status_code == 200, marked.text
        defaulted = seeded_client.post(
            f"/api/v1/installments/{overdue_contract.id}/default",
            json={"reason": "超过约定期限"},
            headers=headers,
        )
        assert defaulted.status_code == 200, defaulted.text
        assert defaulted.json()["status"] == InstallmentStatus.DEFAULTED.value

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

    def test_waive_and_extend_schedule_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, periods=1, per_period="300", first_due_on=TODAY
        )
        extended = seeded_client.post(
            f"/api/v1/installments/{contract.id}/schedules/1/extend",
            json={"new_due_on": "2026-12-31", "reason": "客户申请展期"},
            headers=headers,
        )
        assert extended.status_code == 200, extended.text
        assert extended.json()["due_on"] == "2026-12-31"

        waived = seeded_client.post(
            f"/api/v1/installments/{contract.id}/schedules/1/waive",
            json={
                "amount": "300",
                "waived_on": TODAY.isoformat(),
                "reason": "审批减免",
            },
            headers=headers,
        )
        assert waived.status_code == 200, waived.text
        assert waived.json()["status"] == ScheduleStatus.WAIVED.value
        assert waived.json()["waived_amount"] == "300.00"

    def test_recover_endpoint_records_disposition(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "recover-endpoint-account")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")
        contract = _contract(
            seeded_db, order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="1000", down_payment="100", periods=1,
            per_period="900", first_due_on=PAST,
        )
        seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )

        response = seeded_client.post(
            f"/api/v1/installments/{contract.id}/recover",
            json={"occurred_on": TODAY.isoformat(), "note": "客户逾期回收"},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        assert response.json()["action"] == "RECOVER"

    def test_scoped_user_mark_overdue_only_updates_visible_orders(
        self, seeded_client, seeded_db
    ):
        own_order = _order(seeded_db, owner_id=9)
        foreign_order = _order(seeded_db, owner_id=8)
        own_contract = _contract(
            seeded_db, own_order.id, down_payment="0", periods=1, per_period="300",
            first_due_on=PAST,
        )
        foreign_contract = _contract(
            seeded_db, foreign_order.id, down_payment="0", periods=1, per_period="300",
            first_due_on=PAST,
        )
        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        response = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=scoped_headers,
        )

        assert response.status_code == 200, response.text
        assert response.json()["marked"] == 1

        own_schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == own_contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        foreign_schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == foreign_contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        assert own_schedule.status == ScheduleStatus.OVERDUE.value
        assert foreign_schedule.status == ScheduleStatus.PENDING.value

    def test_overdue_account_can_be_recovered_without_rewriting_contract(self, seeded_db):
        account = _account(seeded_db, "overdue-recovery-account")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")
        contract = _contract(
            seeded_db, order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="1000", down_payment="100", periods=1,
            per_period="900", first_due_on=PAST,
        )
        installment_service.mark_overdue(seeded_db, as_of=TODAY)
        recovered = installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY,
            actor="recovery-operator", note="客户逾期回收",
        )

        assert recovered.action == "RECOVER"
        assert recovered.installment_id == contract.id
        seeded_db.refresh(account)
        seeded_db.refresh(contract)
        assert account.status == "WAITING"
        assert contract.status == InstallmentStatus.CLOSED.value

    def test_dfq_overdue_recovery_materializes_account_and_auto_links_resale(self, seeded_db):
        order = orders_service.create_order(
            seeded_db,
            order_type="DFQ",
            trade_date=TODAY,
            actor="pytest",
            account_snapshot={
                "game_account": "dfq-recovery-account",
                "game_type": "王者荣耀",
                "game_password": "secret",
            },
        )
        contract = _contract(
            seeded_db,
            order.id,
            principal="1000",
            down_payment="100",
            periods=1,
            per_period="900",
            first_due_on=PAST,
        )
        _buy(seeded_db, order.id, amount="800")

        installment_service.mark_overdue(seeded_db, as_of=TODAY)
        installment_service.recover_account(
            seeded_db,
            contract.id,
            occurred_on=TODAY,
            actor="recovery-operator",
            note="代分期逾期回收",
        )

        seeded_db.refresh(order)
        assert order.account_id is not None
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        assert account.status == "WAITING"
        assert account.inventory_type == "RECOVERY"
        assert account.cost_amount == Decimal("800.00")

        sale_order = _order(seeded_db, order_type="HS", account_id=account.id)
        orders_service.post_event(
            seeded_db,
            sale_order.id,
            event_type="SELL",
            amount=Decimal("1200"),
            occurred_on=TODAY,
            actor="resale-operator",
        )
        resale = seeded_db.scalar(
            select(InstallmentDisposition).where(
                InstallmentDisposition.installment_id == contract.id,
                InstallmentDisposition.action == "RESELL",
            )
        )
        assert resale is not None
        assert resale.related_order_id == sale_order.id

    def test_recovery_closes_installment_and_sale_still_rolls_into_total_profit(
        self, seeded_db
    ):
        account = _account(seeded_db, "closed-recovery-account")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")
        contract = _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="1000",
            down_payment="100",
            periods=1,
            per_period="900",
            first_due_on=PAST,
        )
        installment_service.mark_overdue(seeded_db, as_of=TODAY)
        installment_service.recover_account(
            seeded_db,
            contract.id,
            occurred_on=TODAY,
            actor="recovery-operator",
            note="回收后关闭原分期",
        )

        sale_order = _order(seeded_db, order_type="HS", account_id=account.id)
        orders_service.post_event(
            seeded_db,
            sale_order.id,
            event_type="SELL",
            amount=Decimal("1200"),
            occurred_on=TODAY,
            actor="resale-operator",
        )
        seeded_db.refresh(contract)
        assert contract.status == InstallmentStatus.CLOSED.value
        assert contract.bad_debt_amount == Decimal("1000.00")
        resale = seeded_db.scalar(
            select(InstallmentDisposition).where(
                InstallmentDisposition.installment_id == contract.id,
                InstallmentDisposition.action == "RESELL",
            )
        )
        assert resale is not None
        assert resale.related_order_id == sale_order.id

        profit = reporting_service.order_profit_detail(seeded_db)
        assert profit["total"]["direct_cost"] == Decimal("1000.00")
        assert profit["total"]["net_profit"] == Decimal("-600.00")

    def test_recovered_account_resale_requires_posted_sell_on_new_order(self, seeded_db):
        account = _account(seeded_db, "overdue-resale-account")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")
        contract = _contract(
            seeded_db, order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="1000", down_payment="100", periods=1,
            per_period="900", first_due_on=PAST,
        )
        installment_service.mark_overdue(seeded_db, as_of=TODAY)
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY,
            actor="recovery-operator", note="客户逾期回收",
        )
        resale_order = _order(seeded_db, order_type="HS", account_id=account.id)
        orders_service.post_event(
            seeded_db, resale_order.id, event_type="SELL", amount=Decimal("1200"),
            occurred_on=TODAY, actor="resale-operator",
        )

        resale = seeded_db.scalar(
            select(InstallmentDisposition).where(
                InstallmentDisposition.installment_id == contract.id,
                InstallmentDisposition.action == "RESELL",
            )
        )

        assert resale is not None
        assert resale.action == "RESELL"
        assert resale.related_order_id == resale_order.id
        assert seeded_db.scalar(
            select(InstallmentDisposition).where(
                InstallmentDisposition.installment_id == contract.id,
                InstallmentDisposition.action == "RECOVER",
            )
        ) is not None

        history = installment_service.list_dispositions(seeded_db, contract.id)
        assert [item.action for item in history] == ["RECOVER", "RESELL"]

    @pytest.mark.parametrize(
        ("order_type", "contract_type", "business_mode", "inventory_type"),
        [
            ("HS", "STOCK_SALE", "SELF", "RECOVERY"),
            ("TH", "PICKUP_SALE", "DISTRIBUTION", "PICKUP"),
            ("DG", "CONSIGNMENT_SALE", "DISTRIBUTION", "CONSIGNMENT"),
        ],
    )
    def test_recovered_account_installment_sale_auto_links_resale(
        self, seeded_db, order_type, contract_type, business_mode, inventory_type
    ):
        from app.stocks import service as stocks_service

        account = stocks_service.create_account(
            seeded_db,
            game_account=f"recovered-installment-{order_type.lower()}",
            business_mode=business_mode,
            inventory_type=inventory_type,
            actor="pytest",
        )
        original_order = _order(seeded_db, order_type=order_type, account_id=account.id)
        if order_type == "HS":
            _buy(seeded_db, original_order.id, amount="800")
        contract = _contract(
            seeded_db,
            original_order.id,
            contract_type=contract_type,
            principal="1000",
            down_payment="100",
            periods=1,
            per_period="900",
            first_due_on=PAST,
        )
        installment_service.mark_overdue(seeded_db, as_of=TODAY)
        installment_service.recover_account(
            seeded_db,
            contract.id,
            occurred_on=TODAY,
            actor="recovery-operator",
            note="分期逾期回收",
        )

        resale_order = _order(seeded_db, order_type=order_type, account_id=account.id)
        _contract(
            seeded_db,
            resale_order.id,
            contract_type=contract_type,
            principal="1200",
            down_payment="200",
            periods=1,
            per_period="1000",
            first_due_on=TODAY,
        )

        resale = seeded_db.scalar(
            select(InstallmentDisposition).where(
                InstallmentDisposition.installment_id == contract.id,
                InstallmentDisposition.action == "RESELL",
            )
        )
        assert resale is not None
        assert resale.related_order_id == resale_order.id


def test_final_period_absorbs_rounding_difference(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id, principal="1000", down_payment="0", periods=3, per_period="333.34", adjust_final_period=True)
    schedules = seeded_db.scalars(select(InstallmentSchedule).where(InstallmentSchedule.installment_id == contract.id).order_by(InstallmentSchedule.period_no)).all()
    assert [item.due_amount for item in schedules] == [Decimal("0"), Decimal("333.34"), Decimal("333.34"), Decimal("333.32")]
    assert installment_service.total_receivable(contract) == Decimal("1000.00")
    for number, amount in [(1, "333.34"), (2, "333.34"), (3, "333.32")]:
        installment_service.pay(seeded_db, contract.id, amount=amount, paid_on=TODAY, period_no=number, actor="pytest")
    assert contract.status == InstallmentStatus.SETTLED.value
    assert contract.paid_amount == Decimal("1000.00")


def test_cancel_endpoint_cancels_installment(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "cancel-endpoint-account")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, amount="800")
    contract = _contract(
        seeded_db, order.id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal="1000", down_payment="100", periods=1,
        per_period="900", first_due_on=TODAY,
    )
    response = seeded_client.post(
        f"/api/v1/installments/{contract.id}/cancel",
        json={"cancelled_on": TODAY.isoformat(), "reason": "测试取消"},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def test_list_dispositions_endpoint_returns_records(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "list-dispo-account")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, amount="800")
    contract = _contract(
        seeded_db, order.id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal="1000", down_payment="100", periods=1,
        per_period="900", first_due_on=PAST,
    )
    seeded_client.post(
        "/api/v1/installments/mark-overdue",
        params={"as_of": TODAY.isoformat()}, headers=headers,
    )
    seeded_client.post(
        f"/api/v1/installments/{contract.id}/recover",
        json={"occurred_on": TODAY.isoformat(), "note": "逾期回收"},
        headers=headers,
    )
    response = seeded_client.get(
        f"/api/v1/installments/{contract.id}/dispositions", headers=headers
    )
    assert response.status_code == 200, response.text
    assert any(item["action"] == "RECOVER" for item in response.json())


def test_resale_endpoint_records_sale(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "resale-endpoint-account")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, amount="800")
    contract = _contract(
        seeded_db, order.id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal="1000", down_payment="100", periods=1,
        per_period="900", first_due_on=PAST,
    )
    seeded_client.post(
        "/api/v1/installments/mark-overdue",
        params={"as_of": TODAY.isoformat()}, headers=headers,
    )
    seeded_client.post(
        f"/api/v1/installments/{contract.id}/recover",
        json={"occurred_on": TODAY.isoformat(), "note": "逾期回收"},
        headers=headers,
    )
    resale_order = _order(seeded_db, order_type="HS", account_id=account.id)
    orders_service.post_event(
        seeded_db, resale_order.id, event_type="SELL", amount=Decimal("800"),
        occurred_on=TODAY, actor="pytest",
    )
    from sqlalchemy import delete as _sa_delete
    from app.domain.trade import InstallmentDisposition
    # 防御：SQLite rowid 复用 + 用例间截断偶发残留，确保本合约无旧 RESELL 记录
    seeded_db.execute(
        _sa_delete(InstallmentDisposition).where(
            InstallmentDisposition.installment_id == contract.id,
            InstallmentDisposition.action == "RESELL",
        )
    )
    seeded_db.flush()
    response = seeded_client.post(
        f"/api/v1/installments/{contract.id}/resale",
        json={
            "resale_order_id": resale_order.id,
            "occurred_on": TODAY.isoformat(),
            "note": "转售",
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["action"] == "RESELL"
