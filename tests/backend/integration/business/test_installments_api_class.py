"""API-01 分期 HTTP API 契约：TestInstallmentsApi 拆出（12 tests）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    EventType,
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus,
)
from app.domain.foundation import AuditLog
from app.domain.trade import Cashflow, Installment, InstallmentSchedule, Order, OrderEvent
from app.domain.users import User
from app.installments import _shared as inst__shared
from app.installments import create as inst_create
from app.installments import queries as inst_queries
from app.installments import recovery as inst_recovery
from app.installments.repayments.pay import pay as inst_pay
from app.installments import settlement as inst_settlement
from app.orders.create import create_order
from app.orders.events import post_event

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)

def _account(seeded_db, game_account: str):
    from app.stocks.profile import create_account

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

    def test_detail_can_update_action_operators(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id)

        response = seeded_client.put(
            f"/api/v1/installments/{contract.id}/operation-operators/CREATE",
            json={"operator_user_ids": [1, 2]},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        create_operator_row = next(
            row for row in response.json()["operation_operators"]
            if row["operation_key"] == "CREATE"
        )
        assert create_operator_row["operator_user_ids"] == [1, 2]

    def test_list_endpoint_returns_order_context_from_database(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db, order_type="TH", trade_date=PAST)
        contract = _contract(seeded_db, order.id)

        response = seeded_client.get("/api/v1/installments", headers=headers)

        assert response.status_code == 200, response.text
        row = next(item for item in response.json() if item["id"] == contract.id)
        assert {
            key: row["order"][key]
            for key in ("id", "order_no", "order_type", "trade_date")
        } == {
            "id": order.id,
            "order_no": order.order_no,
            "order_type": "TH",
            "trade_date": PAST.isoformat(),
        }

    def test_list_endpoint_returns_schedule_and_disposition_details(
        self, seeded_client, seeded_db, headers
    ):
        account = _account(seeded_db, "installment-list-details")
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
        inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
        inst_recovery.recover_account(
            seeded_db,
            contract.id,
            occurred_on=TODAY,
            note="逾期回收",
            actor="pytest",
        )

        response = seeded_client.get("/api/v1/installments", headers=headers)

        assert response.status_code == 200, response.text
        row = next(item for item in response.json() if item["id"] == contract.id)
        assert row["schedules"][0]["installment_id"] == contract.id
        assert row["dispositions"][0]["action"] == "RECOVER"

    def test_deliver_endpoint(self, seeded_client, seeded_db, headers):
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
        response = seeded_client.post(
            f"/api/v1/installments/{contract.id}/deliver",
            json={
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
            "delivery_direction": "SELL",
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
        inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
        recovered = inst_recovery.recover_account(
            seeded_db, contract.id, occurred_on=TODAY,
            actor="recovery-operator", note="客户逾期回收",
        )

        assert recovered.action == "RECOVER"
        assert recovered.installment_id == contract.id
        seeded_db.refresh(account)
        seeded_db.refresh(contract)
        assert account.status == "WAITING"
        assert contract.status == InstallmentStatus.CLOSED.value


