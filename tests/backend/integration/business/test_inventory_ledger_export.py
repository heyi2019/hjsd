"""EXPORT-01 库存台账导出由服务端按注册列输出。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
import csv
import io
import pytest
from types import SimpleNamespace
from sqlalchemy import event as sqlalchemy_event, text
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.business.shared.order_detail.view import execution
from app.business.inventory.profile import create_account
from app.business.inventory import collaboration
from app.core.security import CurrentUser
from app.domain.trade import Cashflow, Installment, InstallmentDisposition, RebateRecord
from app.shared.audit import record_audit


def test_export_recovers_when_batch_loader_is_unavailable(seeded_client, headers, seeded_db, monkeypatch):
    account = create_account(seeded_db, game_account="export-no-batch-loader", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 10, 1), actor="pytest")
    monkeypatch.setattr(collaboration, "_order_execution_batch_loader", None)
    user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"])
    with pytest.raises(RuntimeError, match="批量加载器未注册"):
        collaboration.load_order_execution_batch(seeded_db, [order.id], user)

    response = seeded_client.get("/api/stocks/inventory/ledger/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["X-Inventory-Detail-Failures"] == "0"
    rows = list(csv.DictReader(io.StringIO(response.text.lstrip("\ufeff"))))
    assert next(row for row in rows if row["订单号"] == order.order_no)["支出笔数"] == "1"


def test_inventory_export_batches_order_detail_queries(seeded_client, headers, seeded_db):
    order_numbers = []
    for i in range(5):
        account = create_account(seeded_db, game_account=f"inventory-export-batch-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
        order_numbers.append(order.order_no)
        post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 10, 1), actor="pytest")
    statements, audits = [], []

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        sql = " ".join(statement.lower().split())
        if sql.startswith("select") and "from order_events" in sql:
            statements.append(sql)
        if sql.startswith("select") and "from audit_logs" in sql:
            audits.append(sql)

    sqlalchemy_event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        response = seeded_client.get("/api/stocks/inventory/ledger/export.csv", headers=headers)
    finally:
        sqlalchemy_event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)
    assert response.status_code == 200, response.text
    assert all(number in response.text for number in order_numbers)
    assert len(statements) <= 4
    assert len(audits) <= 1


def test_restricted_inventory_batch_does_not_query_account_scope_per_row(seeded_db):
    orders = []
    for i in range(5):
        account = create_account(seeded_db, game_account=f"inventory-scope-batch-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id, owner_id=1)
        post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 10, 1), actor="pytest")
        orders.append(order)
    statements = []
    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        sql = " ".join(statement.lower().split())
        if sql.startswith("select") and "from stocks" in sql and "where stocks.id =" in sql:
            statements.append(sql)
    user = CurrentUser.build(id=1, username="restricted", roles=["EMPLOYEE"], owner_scope="SELF")
    sqlalchemy_event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        details = execution.load_order_execution_details_for_export(seeded_db, [order.id for order in orders], user)
    finally:
        sqlalchemy_event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)
    assert all(detail is not None for detail in details)
    assert len(statements) <= 1


def test_batch_detail_matches_single_order_and_keeps_bad_debt_and_permissions(seeded_db):
    orders, accounts = [], []
    for i in range(2):
        account = create_account(seeded_db, game_account=f"inventory-parity-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id, owner_id=i + 1)
        order.form_extra = {"business_responsible_ids": [i + 1]}
        event, _ = post_event(seeded_db, order.id, event_type="BUY", amount=str(100 + i * 50), occurred_on=date(2026, 10, 1), actor="pytest")
        record_audit(seeded_db, action="ORDER_UPDATE", entity_type="inventory_event_edit", entity_id=event.id, actor="pytest")
        record_audit(seeded_db, action="ORDER_UPDATE", entity_type="order", entity_id=order.order_no, actor="pytest")
        orders.append(order)
        accounts.append(account)
    inst = Installment(inst_no="EXPORT-BAD-DEBT", order_id=orders[0].id, contract_type="STOCK_SALE", periods=1,
                       bad_debt_amount=Decimal("30"), status="DEFAULTED", created_by="pytest", updated_by="pytest")
    seeded_db.add(inst)
    seeded_db.flush()
    seeded_db.add(InstallmentDisposition(installment_id=inst.id, account_id=accounts[0].id, action="RECOVER",
                                         occurred_on=date(2026, 10, 2), note="坏账", created_by="pytest", updated_by="pytest"))
    seeded_db.flush()
    admin = CurrentUser.build(id=1, username="admin", roles=["ADMIN"])
    expected = [execution.load_order_execution_detail(seeded_db, order.id, admin).model_dump(mode="json") for order in orders]
    actual = execution.load_order_execution_details_for_export(seeded_db, [order.id for order in orders], admin)
    assert [item.model_dump(mode="json") for item in actual] == expected
    assert actual[0].finance_summary.total_expense == Decimal("130")
    assert actual[1].finance_summary.total_expense == Decimal("150")
    restricted = CurrentUser.build(id=1, username="restricted", roles=["EMPLOYEE"], owner_scope="SELF")
    restricted_results = execution.load_order_execution_details_for_export(seeded_db, [order.id for order in orders], restricted)
    assert restricted_results[0] is not None
    assert restricted_results[0].model_dump(mode="json") == execution.load_order_execution_detail(seeded_db, orders[0].id, restricted).model_dump(mode="json")
    assert restricted_results[1] is None


def test_batch_detail_keeps_rebate_scope_with_cross_order_historical_reference(seeded_db):
    orders = []
    for i in range(2):
        account = create_account(seeded_db, game_account=f"inventory-rebate-scope-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        orders.append(create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id))
    rebate = RebateRecord(rebate_no="LEGACY-RB-SCOPE", source_order_id=orders[0].id, rebate_type="BUY", amount=Decimal("50"), collected_on=date(2026, 10, 1), created_by="pytest", updated_by="pytest")
    seeded_db.add(rebate)
    seeded_db.flush()
    post_event(seeded_db, orders[1].id, event_type="REBATE", rebate_type="BUY", amount="50", occurred_on=date(2026, 10, 1), actor="pytest", source_type="REBATE", source_id=rebate.rebate_no)
    user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"])
    expected = execution.load_order_execution_detail(seeded_db, orders[0].id, user)
    actual = execution.load_order_execution_details_for_export(seeded_db, [order.id for order in orders], user)[0]
    assert expected.finance_summary.rebate_income == Decimal("50")
    assert actual.finance_summary == expected.finance_summary
    assert actual.detail_view == expected.detail_view


def test_batch_detail_reuses_single_order_loader_for_duplicate_event_cashflows(seeded_db, monkeypatch):
    orders = []
    for i in range(2):
        account = create_account(seeded_db, game_account=f"inventory-duplicate-flow-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
        event, flow = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 10, 1), actor="pytest")
        orders.append(order)
        if i == 0:
            seeded_db.add(Cashflow(flow_no="DUPLICATE-EVENT-FLOW", pool_id=flow.pool_id, occurred_on=flow.occurred_on,
                                   ledger_type=flow.ledger_type, accounting_attribute=flow.accounting_attribute,
                                   category=flow.category, direction=flow.direction, amount=Decimal("15"),
                                   source_type="ORDER_EVENT", source_id=event.event_no, order_id=order.id,
                                   created_by="pytest", updated_by="pytest"))
    seeded_db.flush()
    user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"])
    expected = [execution.load_order_execution_detail(seeded_db, order.id, user).model_dump(mode="json") for order in orders]
    original = execution._assemble_order_execution_detail
    calls = []

    def spy(db, order, account, user, **kwargs):
        calls.append((order.id, kwargs.get("preloaded") is None))
        return original(db, order, account, user, **kwargs)

    monkeypatch.setattr(execution, "_assemble_order_execution_detail", spy)
    actual = execution.load_order_execution_details_for_export(seeded_db, [order.id for order in orders], user)
    assert [item.model_dump(mode="json") for item in actual] == expected
    assert calls == [(orders[0].id, True), (orders[1].id, False)]


def test_inventory_batch_loader_splits_501_orders_without_changing_order(seeded_db, monkeypatch):
    calls = []
    monkeypatch.setattr(execution, "_visible_order_accounts", lambda db, ids, user: {
        item: (SimpleNamespace(id=item, account_id=item), SimpleNamespace(id=item)) for item in ids
    })
    monkeypatch.setattr(execution, "load_relations", lambda db, orders: SimpleNamespace(order_extra_values={}))
    def load_context(db, ids):
        calls.append(len(ids))
        return SimpleNamespace(events_by_order={}, duplicate_event_cashflow_sources=set())
    monkeypatch.setattr(execution, "load_event_context", load_context)
    monkeypatch.setattr(execution, "_account_outputs", lambda db, accounts, user, **kwargs: accounts)
    monkeypatch.setattr(execution, "order_profit_flow_by_order", lambda db, **kwargs: {})
    monkeypatch.setattr(execution, "_assemble_order_execution_detail", lambda db, order, account, user, **kwargs: order.id)
    user = CurrentUser.build(id=1, username="test", roles=["EMPLOYEE"])
    assert execution.load_order_execution_details_for_export(seeded_db, [], user) == []
    assert calls == []
    order_ids = list(range(1, 502))
    assert execution.load_order_execution_details_for_export(seeded_db, order_ids, user) == order_ids
    assert calls == [500, 1]


def test_inventory_export_falls_back_per_row_when_batch_prefetch_fails(seeded_client, headers, seeded_db, monkeypatch):
    account = create_account(seeded_db, game_account="inventory-export-fallback", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 10, 1), actor="pytest")
    original = execution.load_event_context
    calls = 0

    def fail_once(db, order_ids):
        nonlocal calls
        calls += 1
        if calls == 1:
            db.execute(text("SELECT 1/0"))
        return original(db, order_ids)

    monkeypatch.setattr(execution, "load_event_context", fail_once)
    response = seeded_client.get("/api/stocks/inventory/ledger/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["X-Inventory-Detail-Failures"] == "0"
    assert order.order_no in response.text


def test_inventory_export_preserves_single_row_failure(seeded_client, headers, seeded_db, monkeypatch):
    orders = []
    for i in range(2):
        account = create_account(seeded_db, game_account=f"inventory-export-row-failure-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
        post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 10, 1), actor="pytest")
        orders.append(order)
    original = execution._assemble_order_execution_detail

    def fail_one(db, order, account, user, **kwargs):
        if order.id == orders[0].id:
            db.execute(text("SELECT 1/0"))
        return original(db, order, account, user, **kwargs)

    monkeypatch.setattr(execution, "_assemble_order_execution_detail", fail_one)
    response = seeded_client.get("/api/stocks/inventory/ledger/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["X-Inventory-Detail-Failures"] == "1"
    assert all(order.order_no in response.text for order in orders)
    rows = list(csv.DictReader(io.StringIO(response.text.lstrip("\ufeff"))))
    assert next(row for row in rows if row["订单号"] == orders[1].order_no)["支出笔数"] == "1"


def test_batch_only_assembly_failure_retries_original_single_order(seeded_db, monkeypatch):
    orders = []
    for i in range(2):
        account = create_account(seeded_db, game_account=f"inventory-batch-retry-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        orders.append(create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id))
    original = execution._assemble_order_execution_detail

    def fail_batch_only(db, order, account, user, **kwargs):
        if order.id == orders[0].id and kwargs.get("preloaded") is not None:
            db.execute(text("SELECT 1/0"))
        return original(db, order, account, user, **kwargs)

    monkeypatch.setattr(execution, "_assemble_order_execution_detail", fail_batch_only)
    user = CurrentUser.build(id=1, username="admin", roles=["ADMIN"])
    results = execution.load_order_execution_details_for_export(seeded_db, [order.id for order in orders], user)
    assert all(result is not None for result in results)
    assert seeded_db.execute(text("SELECT 1")).scalar_one() == 1


def test_batch_does_not_retry_invisible_order(seeded_db, monkeypatch):
    account = create_account(seeded_db, game_account="inventory-permission-fail-once", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id, owner_id=2)
    restricted = CurrentUser.build(id=1, username="restricted", roles=["EMPLOYEE"], owner_scope="SELF")
    calls = []
    def reject_fallback(*_args):
        calls.append(True)
        raise AssertionError("不可见订单不得走逐条回退")
    monkeypatch.setattr(execution, "get_order", reject_fallback)
    assert execution.load_order_execution_details_for_export(seeded_db, [order.id], restricted) == [None]
    assert calls == []


def test_batch_permission_sql_failure_does_not_lose_other_rows(seeded_db, monkeypatch):
    orders = []
    for i in range(2):
        account = create_account(seeded_db, game_account=f"inventory-validation-failure-{i}", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
        orders.append(create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id))
    admin = CurrentUser.build(id=1, username="admin", roles=["ADMIN"])
    original = execution.get_order

    def fail_batch(db, _order_ids, _user):
        db.execute(text("SELECT 1/0"))
    monkeypatch.setattr(execution, "_visible_order_accounts", fail_batch)

    def fail_one(db, order_id, user):
        if order_id == orders[1].id:
            db.execute(text("SELECT 1/0"))
        return original(db, order_id, user)

    monkeypatch.setattr(execution, "get_order", fail_one)
    results = execution.load_order_execution_details_for_export(seeded_db, [order.id for order in orders], admin)
    assert results[0] is not None
    assert results[1] is None
    assert seeded_db.execute(text("SELECT 1")).scalar_one() == 1


def test_inventory_ledger_export_is_server_owned(seeded_client, headers):
    response = seeded_client.get(
        "/api/stocks/inventory/ledger/export.csv",
        params={
            "business_mode": "SELF",
            "inventory_type": "RECOVERY",
            "game_type": "王者荣耀",
            "keyword": "账号-1",
            "date_from": "2026-01-01",
            "date_to": "2026-12-31",
            "sort_desc": "false",
        },
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.text.startswith("\ufeff订单号,业务,类型")


def test_inventory_ledger_export_has_no_total_limit(seeded_client, headers, monkeypatch):
    from app.business.inventory.inventory import inventory_ledger
    seen = []
    def spy(db, **kwargs):
        seen.append(kwargs.get("limit"))
        return inventory_ledger(db, **kwargs)
    monkeypatch.setattr("app.business.inventory.router.stocks_inventory_ledger", spy)
    response = seeded_client.get("/api/stocks/inventory/ledger/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    assert seen == [None]
