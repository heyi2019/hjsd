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
from app.business.installments import _shared as inst__shared
from app.shared.installment_amounts import total_receivable
from app.business.installments import create as inst_create
from app.business.installments import queries as inst_queries
from app.business.installments.repayments.pay import pay as inst_pay
from app.business.installments.repayments.cancel import cancel_installment as inst_cancel
from app.business.orders.create import create_order
from app.business.orders.events import post_event

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)


def test_installments_page_limits_results_and_preserves_total(seeded_client, seeded_db, headers):
    contracts = [_contract(seeded_db, _order(seeded_db).id) for _ in range(11)]
    contracts[0].status = "CANCELLED"
    seeded_db.flush()

    first = seeded_client.get("/api/installments", params={"limit": 2, "offset": 0, "sort_desc": "true"}, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["total"] == 11
    assert [item["id"] for item in first.json()["items"]] == [contracts[10].id, contracts[9].id]
    assert first.json()["items"][0]["schedules"]
    second = seeded_client.get("/api/installments", params={"limit": 2, "offset": 10, "sort_desc": "true"}, headers=headers)
    assert [item["id"] for item in second.json()["items"]] == [contracts[0].id]
    ascending = seeded_client.get("/api/installments", params={"limit": 2, "sort_desc": "false", "status": "PENDING"}, headers=headers)
    assert ascending.json()["total"] == 10
    assert [item["id"] for item in ascending.json()["items"]] == [contracts[1].id, contracts[2].id]
    exported = seeded_client.get("/api/installments/export.csv", headers=headers)
    assert exported.status_code == 200, exported.text
    assert all(contract.inst_no in exported.text for contract in contracts)


def test_installment_export_reuses_detail_queries_and_preserves_schedule_content(seeded_client, seeded_db, headers):
    import csv
    import io
    import json
    from sqlalchemy import event

    order = _order(seeded_db)
    contract = _contract(seeded_db, order.id, down_payment="0", periods=1, per_period="200")
    statements = []
    connection = seeded_db.connection()
    def observe(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(" ".join(statement.lower().split()))
    event.listen(connection, "before_cursor_execute", observe)
    try:
        response = seeded_client.get("/api/installments/export.csv", headers=headers)
    finally:
        event.remove(connection, "before_cursor_execute", observe)
    assert response.status_code == 200, response.text
    rows = list(csv.DictReader(io.StringIO(response.text.lstrip("\ufeff"))))
    row = next(item for item in rows if contract.inst_no in item.values())
    schedules = json.loads(row["期次明细"])
    first = next(item for item in schedules if item["期次"] == 1)
    assert first["应收金额"] == "200.00"
    assert first["available_actions"] == []
    assert sum("from installment_schedules" in sql for sql in statements) == 1
    assert sum("from installment_dispositions" in sql for sql in statements) == 1


def test_installment_order_context_reads_only_display_fields(seeded_db):
    from sqlalchemy import event
    from app.customers.counterparties import create_counterparty
    from app.customers.customers import create_customer

    account = _account(seeded_db, "installment-context-account")
    account.business_mode = "DISTRIBUTION"
    account.inventory_type = "PICKUP"
    account.bound_phone = "13800000000"
    customer = create_customer(seeded_db, display_name="分期客户", phone="13900000000", actor="pytest")
    counterparty = create_counterparty(seeded_db, display_name="分期同行", type="PEER", phone="13700000000", actor="pytest")
    order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id,
                         customer_roles=[(customer.id, "BUYER")], counterparty_roles=[(counterparty.id, "PEER")])
    order.form_extra = {"sell_bound_phone": "13900000001", "sell_bound_phone_owner": "卖号绑定人"}
    peer_order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
                              counterparty_roles=[(counterparty.id, "PEER")])
    peer_order.account_snapshot = {"game_account": "历史快照账号", "game_type": "游戏类型", "bound_phone": "13600000000", "bound_phone_owner": "客户"}
    cleared_order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
    cleared_order.account_snapshot = {"bound_phone": "13500000000", "bound_phone_owner": "原绑定人"}
    cleared_order.form_extra = {"sell_bound_phone": "", "sell_bound_phone_owner": None}
    seeded_db.flush()
    statements = []

    def record_sql(_conn, _cursor, statement, _params, _context, _many):
        statements.append(" ".join(statement.lower().split()))

    connection = seeded_db.connection()
    event.listen(connection, "after_cursor_execute", record_sql)
    try:
        contexts = inst_queries.installment_order_context(seeded_db, [order, peer_order, cleared_order])
    finally:
        event.remove(connection, "after_cursor_execute", record_sql)
    context = contexts[order.id]
    assert contexts[peer_order.id]["party_name"] == "分期同行"
    assert contexts[peer_order.id]["account_game_account"] == "历史快照账号"
    assert contexts[peer_order.id]["bound_phone"] == "13600000000"
    assert contexts[peer_order.id]["bound_phone_owner"] == "客户"
    assert context["account_game_account"] == "installment-context-account"
    assert context["bound_phone"] == "13900000001"
    assert context["bound_phone_owner"] == "卖号绑定人"
    assert contexts[cleared_order.id]["bound_phone"] == ""
    assert contexts[cleared_order.id]["bound_phone_owner"] is None
    assert context["party_name"] == "分期客户"
    assert len(statements) == 3
    assert all("stocks.game_password" not in sql and "stocks.account_images" not in sql for sql in statements)
    assert all("customers.phone" not in sql and "counterparties.phone" not in sql for sql in statements)

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


@pytest.mark.parametrize(
    ("order_type", "contract_type", "business_mode", "inventory_type", "expected_status"),
    [
        ("TH", "PICKUP_SALE", "DISTRIBUTION", "PICKUP", AccountStatus.WAITING.value),
    ],
)
def test_cancel_distribution_installment_uses_business_specific_account_result(
    seeded_db, order_type, contract_type, business_mode, inventory_type, expected_status
):
    from app.business.inventory.profile import create_account

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


def test_settle_early_keeps_submitted_form_extra(seeded_db):
    from app.business.installments.settlement import settle_early
    order = _order(seeded_db)
    contract = _contract(seeded_db, order.id, principal="100", down_payment="0", periods=1, per_period="100")
    result = settle_early(seeded_db, contract.id, paid_on=TODAY, actor="pytest", form_extra={"settlement_reference": "结清备注"})
    seeded_db.flush()
    seeded_db.refresh(result)
    assert result.form_extra["settlement_reference"] == "结清备注"


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
        seeded_db.add(Attachment(entity_type="installment", entity_id=contract.inst_no, file_name=f"{number}.png", storage_key=f"repeat/{number}.png", content_type="image/png", size_bytes=1, sha256="a" * 64, created_by="pytest", updated_by="pytest"))
    seeded_db.flush()
    assert len(inst_queries.list_installments(seeded_db, order_id=order.id)) == 2
    with pytest.raises(Conflict):
        _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="250", down_payment="0", periods=1, per_period="250")
    with pytest.raises(IntegrityError):
        with seeded_db.begin_nested():
            seeded_db.add(Installment(inst_no="DB-DUPLICATE-ACTIVE", order_id=order.id, contract_type="STOCK_SALE", principal=250, down_payment=0, periods=1, per_period=250, first_due_on=TODAY, status="PENDING", created_by="pytest", updated_by="pytest"))
            seeded_db.flush()
    detail = seeded_client.get(f"/api/orders/{order.id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["installment"]["id"] == second.id
    assert {item["file_name"] for item in detail.json()["attachments"]} >= {"1.png", "2.png"}


@pytest.mark.parametrize("order_type", ["HS", "TH"])
def test_cancel_installment_then_resell_in_installments(seeded_client, seeded_db, headers, order_type):
    from sqlalchemy import event
    from app.business.orders.router_outputs.list_payload import _order_list_payload
    from app.shared.order_amounts import order_cashflow_profit_by_order
    from app.business.inventory.profile import create_account
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
    contract_rows = []

    def record_rows(_conn, cursor, statement, _params, _context, _many):
        sql = " ".join(statement.lower().split())
        if "from installments where installments.order_id in" in sql:
            contract_rows.append(cursor.rowcount)

    connection = seeded_db.connection()
    event.listen(connection, "after_cursor_execute", record_rows)
    try:
        ledger = _order_list_payload(seeded_db, [order])[0]
    finally:
        event.remove(connection, "after_cursor_execute", record_rows)
    assert contract_rows == [1]
    assert ledger["installment_principal"] == Decimal("250")
    assert ledger["installment_paid"] == Decimal("50")
    assert ledger["installment_periods"] == 1
    assert ledger["installment_status"] == second.status
    assert ledger["profit_base"] == Decimal("-50")
    other_order = _order(seeded_db)
    other_contract = _contract(seeded_db, other_order.id, principal="700", down_payment="100", periods=2, per_period="300")
    both = {item["id"]: item for item in _order_list_payload(seeded_db, [order, other_order])}
    assert both[order.id]["installment_principal"] == Decimal("250")
    assert both[other_order.id]["installment_principal"] == Decimal("700")
    assert both[other_order.id]["installment_status"] == other_contract.status
    response = seeded_client.get(f"/api/orders/{order.id}", headers=headers)
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
    from app.business.orders.create_roles.roles import add_customer_role
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
    rows = seeded_client.get("/api/installments", params={"order_id": order.id}, headers=headers).json()["items"]
    old = next(row for row in rows if row["id"] == first.id)
    assert Decimal(old["total_receivable"]) == 100 and Decimal(old["paid_amount"]) == 50
    assert Decimal(old["remaining_receivable"]) == 0
    totals = seeded_client.get("/api/installments/totals", params={"order_id": order.id}, headers=headers).json()
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
    assert inst_queries.count_installments(seeded_db, user=scoped_user) == 1
    assert [item.id for item in inst_queries.list_installments(seeded_db, user=scoped_user, limit=10, sort_desc=True)] == [own_contract.id]
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
        f"/api/installments/{contract.id}/cancel",
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
        "/api/installments/mark-overdue",
        params={"as_of": TODAY.isoformat()}, headers=headers,
    )
    seeded_client.post(
        f"/api/installments/{contract.id}/recover",
        json={"occurred_on": TODAY.isoformat(), "note": "逾期回收", "recovery_cost": "0"},
        headers=headers,
    )
    response = seeded_client.get(
        f"/api/installments/{contract.id}/dispositions", headers=headers
    )
    assert response.status_code == 200, response.text
    assert any(item["action"] == "RECOVER" for item in response.json())


# —— available_actions 下发契约 ——
def test_available_actions_match_business_rules():
    """后端纯函数按合约状态和处置记录生成可执行动作。"""
    from app.business.installments import action_availability as av

    def expected_actions(status, disps):
        acts = []
        if status not in {"SETTLED", "DELIVERED", "CLOSED", "CANCELLED"}:
            acts.append("pay")
        if status == "SETTLED":
            acts.append("deliver")
        has_rec = "RECOVER" in disps
        if status in {"OVERDUE", "DEFAULTED"} and not has_rec:
            acts.append("recover")
        if status in {"PENDING", "ACTIVE", "OVERDUE"}:
            acts += ["cancel", "settle_early"]
        if status == "OVERDUE":
            acts.append("default")
        return acts

    for status in InstallmentStatus:
        for disps in ([], ["RECOVER"], ["RESELL"], ["RECOVER", "RESELL"]):
            assert av.available_installment_actions(status.value, disps) == expected_actions(status.value, disps)
    for status in ScheduleStatus:
        expected = [] if status in {ScheduleStatus.PAID, ScheduleStatus.WAIVED} else ["waive", "extend"]
        assert av.available_schedule_actions(
            status.value, None, due_amount=Decimal("100"), received_amount=Decimal("0"), waived_amount=Decimal("0")
        ) == expected


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
    response = seeded_client.get("/api/installments", headers=headers)
    assert response.status_code == 200, response.text
    row = next(item for item in response.json()["items"] if item["id"] == contract.id)
    # PENDING 合约：可收款/终止/提前结清，不可交付/回收/违约/出售
    assert set(row["available_actions"]) == {"pay", "cancel", "settle_early"}
    assert row["schedules"], "合约应带期次明细"
    # PENDING 期次：可减免/展期
    assert set(row["schedules"][0]["available_actions"]) == {"waive", "extend"}


def test_schedule_endpoints_return_consistent_available_actions(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "schedule-actions-consistency")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    contract = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="0", periods=1, per_period="200")
    response = seeded_client.get(f"/api/installments/{contract.id}/schedules", headers=headers)
    assert response.status_code == 200
    schedule = next(item for item in response.json() if item["period_no"] == 1)
    assert set(schedule["available_actions"]) == {"waive", "extend"}
    result = seeded_client.post(f"/api/installments/{contract.id}/schedules/1/extend", headers=headers, json={"new_due_on": "2026-12-12", "reason": "客户申请"})
    assert result.status_code == 200, result.text
    assert set(result.json()["available_actions"]) == {"waive", "extend"}
    result = seeded_client.post(f"/api/installments/{contract.id}/schedules/1/waive", headers=headers, json={"amount": "10", "waived_on": "2026-10-13", "reason": "客户申请"})
    assert result.status_code == 200, result.text
    assert set(result.json()["available_actions"]) == {"waive", "extend"}
    inst_cancel(seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="取消交易")
    response = seeded_client.get(f"/api/installments/{contract.id}/schedules", headers=headers)
    assert all(not row["available_actions"] for row in response.json())


def test_schedule_actions_exclude_zero_and_partially_received_periods(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "schedule-actions-receipts")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    contract = _contract(
        seeded_db, order.id, contract_type="STOCK_SALE", principal="400",
        down_payment="0", periods=2, per_period="200", first_due_on=TODAY,
    )
    inst_pay(seeded_db, contract.id, amount=Decimal("50"), paid_on=TODAY, period_no=1, actor="pytest")
    response = seeded_client.get(f"/api/installments/{contract.id}/schedules", headers=headers)
    assert response.status_code == 200
    schedules = {row["period_no"]: row for row in response.json()}
    assert schedules[0]["available_actions"] == []  # 零首付无剩余应收
    assert schedules[1]["available_actions"] == []  # 已部分收款不能减免或展期
    assert set(schedules[2]["available_actions"]) == {"waive", "extend"}
    listing = seeded_client.get("/api/installments", headers=headers).json()["items"]
    listed = next(item for item in listing if item["id"] == contract.id)
    assert {item["period_no"]: item["available_actions"] for item in listed["schedules"]} == {
        period: row["available_actions"] for period, row in schedules.items()
    }
    for period in (0, 1):
        result = seeded_client.post(
            f"/api/installments/{contract.id}/schedules/{period}/extend",
            headers=headers, json={"new_due_on": "2027-12-31", "reason": "客户申请"},
        )
        assert result.status_code == 422, result.text


def test_list_actions_match_default_and_recovery_status_guards(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "contract-action-status")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    contract = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="0", periods=1, per_period="200")
    def actions(status):
        contract.status = status
        seeded_db.flush()
        rows = seeded_client.get("/api/installments", headers=headers).json()["items"]
        return next(row["available_actions"] for row in rows if row["id"] == contract.id)
    assert "default" not in actions("ACTIVE")
    assert "recover" not in actions("CLOSED")
    assert {"default", "recover"}.issubset(actions("OVERDUE"))


def test_cancelled_installment_schedules_cannot_be_waived_or_extended(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "cancelled-schedule-actions")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    contract = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="0", periods=1, per_period="200")
    inst_cancel(seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="取消售出")
    row = next(row for row in seeded_client.get("/api/installments", headers=headers).json()["items"] if row["id"] == contract.id)
    assert all(not schedule["available_actions"] for schedule in row["schedules"])
    base = f"/api/installments/{contract.id}/schedules/1"
    waive = seeded_client.post(f"{base}/waive", headers=headers, json={"amount": "10", "waived_on": "2026-10-13", "reason": "减免"})
    extend = seeded_client.post(f"{base}/extend", headers=headers, json={"new_due_on": "2026-12-12", "reason": "展期"})
    assert waive.status_code in (400, 409, 422), waive.text
    assert extend.status_code in (400, 409, 422), extend.text
    seeded_db.refresh(contract)
    assert contract.waived_amount == 0


def test_recovered_installment_schedules_cannot_be_waived_or_extended(seeded_client, seeded_db, headers):
    from app.business.installments.recovery import recover_account
    account = _account(seeded_db, "recovered-schedule-actions")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, order.id, "100")
    contract = _contract(seeded_db, order.id, contract_type="STOCK_SALE", principal="200", down_payment="0", periods=1, per_period="200")
    contract.status = "OVERDUE"
    seeded_db.flush()
    recover_account(seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="违约回收", recovery_cost=0)
    row = next(row for row in seeded_client.get("/api/installments", headers=headers).json()["items"] if row["id"] == contract.id)
    assert all(not schedule["available_actions"] for schedule in row["schedules"])
    base = f"/api/installments/{contract.id}/schedules/1"
    waive = seeded_client.post(f"{base}/waive", headers=headers, json={"amount": "10", "waived_on": "2026-10-13", "reason": "减免"})
    extend = seeded_client.post(f"{base}/extend", headers=headers, json={"new_due_on": "2026-12-12", "reason": "展期"})
    assert waive.status_code in (400, 409, 422), waive.text
    assert extend.status_code in (400, 409, 422), extend.text
    seeded_db.refresh(contract)
    assert contract.waived_amount == 0 and contract.bad_debt_amount == 200

