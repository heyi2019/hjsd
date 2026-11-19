"""API-01 installments 顶层集成契约：取消分摊/流水归属/负责人范围/末期取整/端点（ACC-01）。

按 class 拆分后的保留文件：仅含模块级 test 函数与共享 helper。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy import select

from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountStatus,
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus)
from app.domain.trade import Cashflow, Installment, InstallmentSchedule
from app.funds.installments import _shared as inst__shared
from app.shared.installment_amounts import total_receivable
from app.funds.installments import create as inst_create
from app.funds.installments import queries as inst_queries
from app.funds.installments.repayments.pay import pay as inst_pay
from app.funds.installments.repayments.cancel import cancel_installment as inst_cancel
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


@pytest.mark.parametrize(
    ("order_type", "contract_type", "business_mode", "inventory_type", "expected_status"),
    [
        ("TH", "PICKUP_SALE", "DISTRIBUTION", "PICKUP", AccountStatus.WAITING.value),
    ],
)
def test_cancel_distribution_installment_uses_business_specific_account_result(
    seeded_db, order_type, contract_type, business_mode, inventory_type, expected_status
):
    from app.business.stocks.profile import create_account

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
    seeded_db.refresh(order)
    assert order.status == "ACTIVE"
    post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("120"), occurred_on=TODAY, actor="pytest")
    assert account.status == "SOLD"

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


def test_cancelled_installment_can_be_replaced_without_losing_history(seeded_client, seeded_db, headers):
    from app.core.errors import Conflict
    from app.domain.attachments import Attachment
    from sqlalchemy.exc import IntegrityError
    account = _account(seeded_db, "installment-retry-account")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    first = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="0", periods=1, per_period="200")
    inst_cancel(seeded_db, first.id, cancelled_on=TODAY, actor="pytest", reason="取消售出")
    second = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="250", down_payment="0", periods=1, per_period="250")
    assert second.id != first.id and second.inst_no != first.inst_no
    assert first.status == "CANCELLED" and second.status == "PENDING"
    for number, contract in enumerate((first, second), 1):
        seeded_db.add(Attachment(attachment_no=f"ATT-REPEAT-{number}", entity_type="installment", entity_id=contract.inst_no, file_name=f"{number}.png", storage_key=f"repeat/{number}.png", content_type="image/png", size_bytes=1, sha256="a" * 64, created_by="pytest", updated_by="pytest"))
    seeded_db.flush()
    assert len(inst_queries.list_installments(seeded_db, order_id=order.id)) == 2
    with pytest.raises(Conflict):
        _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="250", down_payment="0", periods=1, per_period="250")
    with pytest.raises(IntegrityError):
        with seeded_db.begin_nested():
            seeded_db.add(Installment(inst_no="DB-DUPLICATE-ACTIVE", order_id=order.id, contract_type="STOCK_SALE", principal=250, down_payment=0, periods=1, per_period=250, first_due_on=TODAY, status="PENDING", created_by="pytest", updated_by="pytest"))
            seeded_db.flush()
    detail = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["installment"]["id"] == second.id
    assert {item["attachment_no"] for item in detail.json()["attachments"]} >= {"ATT-REPEAT-1", "ATT-REPEAT-2"}


@pytest.mark.parametrize("order_type", ["HS", "TH"])
def test_cancel_installment_then_resell_in_installments(seeded_client, seeded_db, headers, order_type):
    from app.business.router_output import _order_list_payload
    from app.shared.order_amounts import order_cashflow_profit_by_order
    from app.business.stocks.profile import create_account
    account = create_account(seeded_db, game_account=f"repeat-installment-{order_type}", business_mode="SELF" if order_type == "HS" else "DISTRIBUTION", inventory_type="RECOVERY" if order_type == "HS" else "PICKUP", actor="pytest")
    order = _order(seeded_db, order_type=order_type, account_id=account.id)
    _buy(seeded_db, order.id, "100")
    post_event(seeded_db, order.id, event_type="SELL", sale_mode="INSTALLMENT", amount=Decimal("200"), occurred_on=TODAY, actor="pytest")
    first = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="50", periods=1, per_period="150")
    inst_pay(seeded_db, first.id, amount=Decimal("50"), paid_on=TODAY, period_no=0, actor="pytest")
    inst_cancel(seeded_db, first.id, cancelled_on=TODAY, actor="pytest", reason="取消售出")
    post_event(seeded_db, order.id, event_type="SELL", sale_mode="INSTALLMENT", amount=Decimal("250"), occurred_on=TODAY, actor="pytest")
    second = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="250", down_payment="50", periods=1, per_period="200")
    inst_pay(seeded_db, second.id, amount=Decimal("50"), paid_on=TODAY, period_no=0, actor="pytest")
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
    assert any(flow.source_id == first.inst_no for flow in flows)
    assert any(flow.source_id == second.inst_no for flow in flows)
    seeded_db.flush()
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == Decimal("-50")
    ledger = _order_list_payload(seeded_db, [order])[0]
    assert ledger["installment_principal"] == Decimal("250")
    assert ledger["installment_status"] == second.status
    assert ledger["profit_base"] == Decimal("-50")
    response = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["installment"]["id"] == second.id


def test_cancelling_new_installment_only_refunds_its_own_payments(seeded_db):
    account = _account(seeded_db, "separate-installment-refunds")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    first = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="0", periods=1, per_period="200")
    inst_cancel(seeded_db, first.id, cancelled_on=TODAY, actor="pytest", reason="取消旧合约")
    old_flow = Cashflow(flow_no="CF-OLD-INSTALLMENT-PAY", pool_id=1, occurred_on=TODAY, direction="IN", category="INSTALLMENT_PAYMENT", amount=Decimal("30"), source_type="INSTALLMENT", source_id=first.inst_no, order_id=order.id, created_by="pytest", updated_by="pytest")
    seeded_db.add(old_flow)
    seeded_db.flush()
    second = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="250", down_payment="50", periods=1, per_period="200")
    inst_pay(seeded_db, second.id, amount=Decimal("50"), paid_on=TODAY, period_no=0, actor="pytest")
    result = inst_cancel(seeded_db, second.id, cancelled_on=TODAY, actor="pytest", reason="取消新合约")
    assert result["refund_amount"] == Decimal("50")
    assert seeded_db.scalar(select(Cashflow.id).where(Cashflow.source_type == "REVERSAL", Cashflow.source_id == old_flow.flow_no)) is None


def test_cancelled_installment_does_not_inflate_receivable_totals(seeded_client, seeded_db, headers):
    from app.business.create import add_customer_role
    from app.customers.customer_detail import get_customer_detail
    from app.customers.customers import create_customer
    account = _account(seeded_db, "cancelled-installment-totals")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    customer = create_customer(seeded_db, display_name="分期统计客户", actor="pytest")
    add_customer_role(seeded_db, order.id, customer.id, "BUYER", actor="pytest")
    _buy(seeded_db, order.id, "100")
    first = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="100", down_payment="50", periods=1, per_period="50")
    inst_pay(seeded_db, first.id, amount=Decimal("50"), paid_on=TODAY, period_no=0, actor="pytest")
    old_schedule = seeded_db.scalar(select(InstallmentSchedule).where(InstallmentSchedule.installment_id == first.id, InstallmentSchedule.period_no == 1))
    old_schedule.status = "OVERDUE"
    seeded_db.flush()
    inst_cancel(seeded_db, first.id, cancelled_on=TODAY, actor="pytest", reason="取消旧合约")
    second = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="50", periods=1, per_period="150")
    inst_pay(seeded_db, second.id, amount=Decimal("50"), paid_on=TODAY, period_no=0, actor="pytest")
    rows = seeded_client.get("/api/v1/installments", params={"order_id": order.id}, headers=headers).json()
    old = next(row for row in rows if row["id"] == first.id)
    assert Decimal(old["total_receivable"]) == 100 and Decimal(old["paid_amount"]) == 50
    assert Decimal(old["remaining_receivable"]) == 0
    totals = seeded_client.get("/api/v1/installments/totals", params={"order_id": order.id}, headers=headers).json()
    assert Decimal(totals["total_receivable"]) == 200
    assert Decimal(totals["total_paid"]) == 50
    assert Decimal(totals["total_remaining"]) == 150
    detail = get_customer_detail(seeded_db, customer.id)
    assert detail["overview"]["installment_receivable_total"] == 200
    assert detail["overview"]["installment_paid_total"] == 50
    assert detail["overview"]["installment_remaining_total"] == 150
    assert detail["overview"]["overdue_period_count"] == 0
    assert next(item for item in detail["installments"] if item["id"] == first.id)["remaining_amount"] == 0

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
    from app.funds.installments import action_availability as av

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


def test_cancelled_installment_schedules_cannot_be_waived_or_extended(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "cancelled-schedule-actions")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    contract = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="0", periods=1, per_period="200")
    inst_cancel(seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="取消售出")
    row = next(row for row in seeded_client.get("/api/v1/installments", headers=headers).json() if row["id"] == contract.id)
    assert all(not schedule["available_actions"] for schedule in row["schedules"])
    base = f"/api/v1/installments/{contract.id}/schedules/1"
    waive = seeded_client.post(f"{base}/waive", headers=headers, json={"amount": "10", "waived_on": "2026-10-13", "reason": "减免"})
    extend = seeded_client.post(f"{base}/extend", headers=headers, json={"new_due_on": "2026-12-12", "reason": "展期"})
    assert waive.status_code in (400, 409, 422), waive.text
    assert extend.status_code in (400, 409, 422), extend.text
    seeded_db.refresh(contract)
    assert contract.waived_amount == 0

