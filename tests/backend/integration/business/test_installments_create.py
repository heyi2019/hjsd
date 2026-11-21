"""API-01 分期建单校验契约：TestCreateInstallmentValidation 拆出（17 tests）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy.exc import IntegrityError

from app.core.errors import Conflict, ErrorCode, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus)
from app.domain.trade import Installment, InstallmentSchedule
from app.domain.users import User
from app.business.installments import create as inst_create
from app.business.installments import recovery as inst_recovery
from app.business.installments.repayments.pay import pay as inst_pay
from app.business.orders.create import create_order
from app.business.events import post_event

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)

def _account(seeded_db, game_account: str):
    from app.business.inventory.profile import create_account

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


class TestCreateInstallmentValidation:
    @pytest.mark.parametrize(
        ("order_type", "contract_type"),
        [
            ("TH", "PICKUP_SALE"),
        ],
    )
    def test_th_supports_installment_overdue_and_payment(
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

        marked = inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
        assert marked == 1
        seeded_db.refresh(contract)
        assert contract.status == InstallmentStatus.OVERDUE.value

        inst_pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=1,
            actor="pytest",
        )
        seeded_db.refresh(contract)
        assert contract.status == InstallmentStatus.SETTLED.value

    def test_stock_sale_contract_records_account_operator(self, seeded_db):
        account = _account(seeded_db, "installment-account-operator")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")

        contract = inst_create.create_installment(
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
            f"/api/installments/{contract.id}/payments",
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
                contract_type=InstallmentContractType.PICKUP_SALE.value,
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


