"""API-01 installments 顶层集成契约：取消分摊/流水归属/负责人范围/末期取整/端点（ACC-01）。

按 class 拆分后的保留文件：仅含模块级 test 函数与共享 helper。
"""

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
from app.shared.installment_amounts import total_receivable
from app.installments import create as inst_create
from app.installments import queries as inst_queries
from app.installments import recovery as inst_recovery
from app.installments.repayments.pay import pay as inst_pay
from app.installments.repayments.cancel import cancel_installment as inst_cancel
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


@pytest.mark.parametrize(
    ("order_type", "contract_type", "business_mode", "inventory_type", "expected_status"),
    [
        ("TH", "PICKUP_SALE", "DISTRIBUTION", "PICKUP", AccountStatus.VOID.value),
    ],
)
def test_cancel_distribution_installment_uses_business_specific_account_result(
    seeded_db, order_type, contract_type, business_mode, inventory_type, expected_status
):
    from app.stocks.profile import create_account

    account = create_account(
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

    inst_cancel(
        seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="取消分期"
    )

    seeded_db.refresh(account)
    assert account.status == expected_status

def test_installment_payment_is_cashflow_only(seeded_db):
    order = _order(seeded_db)
    contract = _contract(seeded_db, order.id, down_payment="0", periods=1, per_period="100", principal="100")
    inst_pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY, period_no=1, actor="pytest"
    )
    payment_flow = seeded_db.scalar(
        select(Cashflow).where(
            Cashflow.order_id == order.id,
            Cashflow.category == "INSTALLMENT_PAYMENT",
        )
    )
    assert payment_flow is not None
    assert payment_flow.source_type == "INSTALLMENT"
    assert payment_flow.source_id == contract.inst_no

def test_installment_scope_follows_order_owner(seeded_db):
    scoped_user = CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )
    own_order = _order(seeded_db, owner_id=9)
    other_order = _order(seeded_db, owner_id=8)
    own_contract = _contract(seeded_db, own_order.id)
    other_contract = _contract(seeded_db, other_order.id)

    visible = inst_queries.list_installments(seeded_db, user=scoped_user)
    assert [item.id for item in visible] == [own_contract.id]
    with pytest.raises(NotFound):
        inst__shared.get_installment(seeded_db, other_contract.id, scoped_user)


def test_final_period_absorbs_rounding_difference(seeded_db):
    order = _order(seeded_db)
    contract = _contract(seeded_db, order.id, principal="1000", down_payment="0", periods=3, per_period="333.34", adjust_final_period=True)
    schedules = seeded_db.scalars(select(InstallmentSchedule).where(InstallmentSchedule.installment_id == contract.id).order_by(InstallmentSchedule.period_no)).all()
    assert [item.due_amount for item in schedules] == [Decimal("0"), Decimal("333.34"), Decimal("333.34"), Decimal("333.32")]
    assert total_receivable(contract) == Decimal("1000.00")
    for number, amount in [(1, "333.34"), (2, "333.34"), (3, "333.32")]:
        inst_pay(seeded_db, contract.id, amount=amount, paid_on=TODAY, period_no=number, actor="pytest")
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


# —— F5 available_actions 下发契约（等价搬运前端原 9 处判定，行为零变化）——
def test_available_actions_match_legacy_frontend_rules():
    """后端纯函数逐状态/处置穷举，与改造前前端 contractColumns.tsx 判定一致。"""
    from app.installments import action_availability as av

    def legacy_inst(status, disps):
        acts = []
        if status not in {"SETTLED", "DELIVERED", "CLOSED", "CANCELLED"}:
            acts.append("pay")
        if status == "SETTLED":
            acts.append("deliver")
        has_rec, has_resell = "RECOVER" in disps, "RESELL" in disps
        if status in {"CLOSED", "OVERDUE", "DEFAULTED"} and not has_rec:
            acts.append("recover")
        if status in {"PENDING", "ACTIVE", "OVERDUE"}:
            acts += ["cancel", "settle_early"]
        if status in {"ACTIVE", "OVERDUE"}:
            acts.append("default")
        if status in {"CLOSED", "OVERDUE", "DEFAULTED"} and has_rec and not has_resell:
            acts.append("resale")
        return acts

    for status in InstallmentStatus:
        for disps in ([], ["RECOVER"], ["RESELL"], ["RECOVER", "RESELL"]):
            assert av.available_installment_actions(status.value, disps) == legacy_inst(status.value, disps)
    for status in ScheduleStatus:
        expected = [] if status in {ScheduleStatus.PAID, ScheduleStatus.WAIVED} else ["waive", "extend"]
        assert av.available_schedule_actions(status.value) == expected


def test_list_endpoint_emits_available_actions(seeded_client, seeded_db, headers):
    """列表接口真实下发合约级 + 期次级 available_actions；前端只回显。"""
    account = _account(seeded_db, "avail-actions-account")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, amount="800")
    contract = _contract(
        seeded_db, order.id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal="1000", down_payment="100", periods=1,
        per_period="900", first_due_on=TODAY,
    )
    response = seeded_client.get("/api/v1/installments", headers=headers)
    assert response.status_code == 200, response.text
    row = next(item for item in response.json() if item["id"] == contract.id)
    # PENDING 合约：可收款/终止/提前结清，不可交付/回收/违约/出售
    assert set(row["available_actions"]) == {"pay", "cancel", "settle_early"}
    assert row["schedules"], "合约应带期次明细"
    # PENDING 期次：可减免/展期
    assert set(row["schedules"][0]["available_actions"]) == {"waive", "extend"}

