"""DEPOSIT-01 finance HTTP API 契约：TestFinanceApi 拆出（20 tests）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import event, select

from app.business.inventory.profile import create_account
from app.business.form_fields import create_order_form_field
from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.foundation import Pool
from app.domain.enums import CashflowSourceType
from app.domain.trade import Cashflow, OrderFormField
from app.funds.cashflow_queries import list_cashflows
from app.funds.cashflows import create_cashflow
from app.funds.deposits.writes import create_deposit
from app.funds.deposits.reads import list_deposits
from app.funds.rebates import create_rebate
from app.funds.transfers import create_transfer, repair_transfer
from app.funds.reconciliation import create_reconciliation, resolve_reconciliation
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.funds.balances import pool_balance

TODAY = date(2026, 10, 4)


@pytest.mark.parametrize("kind", ["deposit", "reconciliation"])
def test_finance_lists_batch_operation_operators(seeded_client, seeded_db, headers, kind):
    pool = _pool(seeded_db, "HJ_INVEST")
    records = []
    for i in range(3):
        if kind == "deposit":
            item = create_deposit(seeded_db, pool_id=pool.id, amount=Decimal("10"),
                                  paid_on=TODAY, actor="pytest", operator_user_ids=[1, 2])
        else:
            item = create_reconciliation(seeded_db, pool_id=pool.id, reconciled_on=TODAY,
                                         account_label=f"账户{i}", statement_balance=Decimal("0"),
                                         actor="pytest", operator_user_ids=[1, 2])
        records.append(item)
    if kind == "reconciliation":
        resolve_reconciliation(seeded_db, records[0].id, actor="pytest", reason="已核对", operator_user_ids=[2])
    seeded_db.flush()
    operator_queries = []

    def count_queries(_conn, _cursor, statement, _params, _context, _many):
        if "from business_operation_operators" in statement.lower():
            operator_queries.append(statement)

    engine = seeded_db.get_bind()
    event.listen(engine, "before_cursor_execute", count_queries)
    try:
        response = seeded_client.get(f"/api/{'deposits' if kind == 'deposit' else 'reconciliations'}", headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", count_queries)
    assert response.status_code == 200, response.text
    outputs = {row["id"]: row["operation_operators"] for row in response.json()}
    assert set(outputs) == {item.id for item in records}
    for item in records:
        assert any(op["operation_key"] == "CREATE" and op["operator_user_ids"] == [1, 2] for op in outputs[item.id])
    if kind == "reconciliation":
        assert any(op["operation_key"] == "RESOLVE" and op["operator_user_ids"] == [2] for op in outputs[records[0].id])
    assert len(operator_queries) == 1
    endpoint = "deposits" if kind == "deposit" else "reconciliations"
    first = seeded_client.get(f"/api/{endpoint}/page", headers=headers, params={"limit": 2, "offset": 0})
    second = seeded_client.get(f"/api/{endpoint}/page", headers=headers, params={"limit": 2, "offset": 2})
    assert first.status_code == second.status_code == 200
    assert first.json()["total"] == second.json()["total"] == 3
    assert len(first.json()["items"]) == 2
    assert len(second.json()["items"]) == 1
    assert {row["id"] for row in first.json()["items"] + second.json()["items"]} == set(outputs)
    for row in first.json()["items"] + second.json()["items"]:
        assert row["operation_operators"] == outputs[row["id"]]
    from app.funds.routers import deposits_router, reconciliation_router
    dependency = (deposits_router if kind == "deposit" else reconciliation_router).read_access.dependency
    scoped = CurrentUser(id=1, username="admin", roles=(), permissions=frozenset(),
                         pool_ids=frozenset(), owner_scope="SELF")
    seeded_client.app.dependency_overrides[dependency] = lambda: scoped
    try:
        hidden = seeded_client.get(f"/api/{endpoint}/page", headers=headers, params={"pool_id": pool.id})
        assert hidden.status_code == 200
        assert hidden.json()["items"] == []
        assert hidden.json()["total"] == 0
    finally:
        seeded_client.app.dependency_overrides.pop(dependency, None)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool


def _active_order(seeded_db) -> int:
    account = create_account(
        seeded_db,
        game_account=f"finance-active-{uuid4().hex[:10]}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    return order.id


class TestFinanceApi:
    @pytest.mark.parametrize(("action", "scope", "dependency"), [
        ("deposit", "FUNDDEPOSIT", "pool_id"),
        ("deposit-edit", "FUNDDEPOSIT", "pool_id"),
        ("transfer", "FUNDTRANSFER", "source_pool_id"),
        ("reconcile", "FUNDRECON", "account_label"),
        ("resolve", "FUNDCLEAR", "reason"),
        ("return", "FUNDRELEASE", "released_on"),
        ("loss", "FUNDLOSS", "category"),
        ("cancel", "FUNDCANCEL", "reason"),
    ])
    def test_finance_conditional_custom_fields_follow_form_values(
        self, seeded_client, seeded_db, headers, action, scope, dependency,
    ):
        pool = _pool(seeded_db, "HJ_INVEST")
        if action == "transfer":
            target = _pool(seeded_db, "HJ_PROFIT")
            create_cashflow(seeded_db, pool_id=pool.id, occurred_on=TODAY, direction="IN",
                            category="OTHER", amount=Decimal("200"), actor="pytest")
            url = "/api/transfers"
            payload = {"source_pool_id": pool.id, "target_pool_id": target.id,
                       "amount": "10", "occurred_on": TODAY.isoformat()}
        elif action in {"deposit", "deposit-edit"}:
            payload = {"pool_id": pool.id, "amount": "100", "paid_on": TODAY.isoformat()}
            if action == "deposit":
                url = "/api/deposits"
            else:
                deposit = create_deposit(seeded_db, pool_id=pool.id, amount=Decimal("100"),
                                         paid_on=TODAY, actor="pytest")
                url = f"/api/deposits/{deposit.id}"
        elif action == "reconcile":
            url = "/api/reconciliations"
            payload = {"pool_id": pool.id, "reconciled_on": TODAY.isoformat(),
                       "statement_balance": "0", "account_label": "对账账户"}
        elif action == "resolve":
            created = seeded_client.post("/api/reconciliations", headers=headers, json={
                "pool_id": pool.id, "reconciled_on": TODAY.isoformat(),
                "statement_balance": "0", "account_label": "对账账户",
            })
            assert created.status_code == 201, created.text
            url = f"/api/reconciliations/{created.json()['id']}/resolve"
            payload = {"reason": "核对完成"}
        else:
            deposit = create_deposit(seeded_db, pool_id=pool.id, amount=Decimal("100"),
                                     paid_on=TODAY, actor="pytest")
            if action == "return":
                url = f"/api/deposits/{deposit.id}/returns"
                payload = {"amount": "30", "released_on": TODAY.isoformat()}
            elif action == "loss":
                url = f"/api/deposits/{deposit.id}/losses"
                payload = {"amount": "30", "lost_on": TODAY.isoformat(),
                           "category": "违约损失", "reason": "押金未返还"}
            else:
                url = f"/api/deposits/{deposit.id}/cancel"
                payload = {"reason": "登记错误", "cancelled_on": TODAY.isoformat()}

        core_field = seeded_db.scalar(select(OrderFormField).where(
            OrderFormField.order_type_code == scope, OrderFormField.field_key == dependency,
        ))
        if core_field is None:
            core_field = create_order_form_field(seeded_db, order_type_code=scope, field_key=dependency,
                                                 label="依赖字段", actor="pytest")
            core_field.is_custom = False
            seeded_db.flush()
        create_order_form_field(
            seeded_db, order_type_code=scope, field_key="receipt", label="条件凭据", actor="pytest",
            required_when={"field": dependency, "op": "filled"},
        )
        seeded_db.commit()
        request = seeded_client.put if action == "deposit-edit" else seeded_client.post
        missing = request(url, headers=headers, json=payload)
        assert missing.status_code == 422, missing.text
        assert "条件凭据" in missing.text

        spoofed = request(url, headers=headers, json={**payload, "form_extra": {dependency: ""}})
        assert spoofed.status_code == 422, spoofed.text
        assert "条件凭据" in spoofed.text

        saved = request(url, headers=headers, json={**payload, "form_extra": {"receipt": "凭据A"}})
        assert saved.status_code == (201 if action in {"deposit", "transfer", "reconcile"} else 200), saved.text
        if action == "transfer":
            assert all(flow["form_extra"]["receipt"] == "凭据A" for flow in saved.json()["cashflows"])
        else:
            assert saved.json()["form_extra"]["receipt"] == "凭据A"

    def test_deposit_edit_preserves_existing_fields_and_validates_clear(self, seeded_client, seeded_db, headers):
        pool = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=pool.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest",
            form_extra={"receipt": "原始凭据", "past_action": "历史信息"},
        )
        core_field = create_order_form_field(seeded_db, order_type_code="FUNDDEPOSIT", field_key="pool_id",
                                             label="资金账户", actor="pytest")
        core_field.is_custom = False
        seeded_db.flush()
        create_order_form_field(
            seeded_db, order_type_code="FUNDDEPOSIT", field_key="receipt", label="条件凭据", actor="pytest",
            required_when={"field": "pool_id", "op": "filled"},
        )
        seeded_db.commit()
        payload = {"pool_id": pool.id, "amount": "100", "paid_on": TODAY.isoformat()}
        url = f"/api/deposits/{deposit.id}"
        saved = seeded_client.put(url, headers=headers, json=payload)
        assert saved.status_code == 200, saved.text
        assert saved.json()["form_extra"] == {"receipt": "原始凭据", "past_action": "历史信息"}
        changed = seeded_client.put(url, headers=headers, json={**payload, "form_extra": {"receipt": "更新凭据"}})
        assert changed.status_code == 200, changed.text
        assert changed.json()["form_extra"] == {"receipt": "更新凭据", "past_action": "历史信息"}
        cleared = seeded_client.put(url, headers=headers, json={**payload, "form_extra": {"receipt": ""}})
        assert cleared.status_code == 422, cleared.text
        assert "条件凭据" in cleared.text

    def test_deposit_condition_is_optional_when_account_does_not_match(self, seeded_client, seeded_db, headers):
        pool = _pool(seeded_db, "HJ_INVEST")
        other = _pool(seeded_db, "HJ_PROFIT")
        core_field = create_order_form_field(seeded_db, order_type_code="FUNDDEPOSIT", field_key="pool_id",
                                             label="资金账户", actor="pytest")
        core_field.is_custom = False
        seeded_db.flush()
        create_order_form_field(
            seeded_db, order_type_code="FUNDDEPOSIT", field_key="receipt", label="条件凭据", actor="pytest",
            required_when={"field": "pool_id", "op": "eq", "values": [str(other.id)]},
        )
        seeded_db.commit()
        response = seeded_client.post("/api/deposits", headers=headers, json={
            "pool_id": pool.id, "amount": "100", "paid_on": TODAY.isoformat(),
        })
        assert response.status_code == 201, response.text

    def test_deposit_edit_can_clear_optional_number(self, seeded_client, seeded_db, headers):
        pool = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=pool.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest",
            form_extra={"optional_number": 17},
        )
        create_order_form_field(seeded_db, order_type_code="FUNDDEPOSIT", field_key="optional_number",
                                label="可选数字", field_type="NUMBER", actor="pytest")
        seeded_db.commit()
        saved = seeded_client.put(f"/api/deposits/{deposit.id}", headers=headers, json={
            "pool_id": pool.id, "amount": "100", "paid_on": TODAY.isoformat(), "form_extra": {},
        })
        assert saved.status_code == 200, saved.text
        assert saved.json()["form_extra"] is None

    @pytest.mark.parametrize(("action", "scope"), [
        ("return", "FUNDRELEASE"), ("cancel", "FUNDCANCEL"), ("resolve", "FUNDCLEAR"),
    ])
    def test_finance_action_requires_its_custom_fields(self, seeded_client, seeded_db, headers, action, scope):
        pool = _pool(seeded_db, "HJ_INVEST")
        if action == "resolve":
            created = seeded_client.post("/api/reconciliations", headers=headers, json={
                "pool_id": pool.id, "reconciled_on": TODAY.isoformat(), "statement_balance": "0", "account_label": "账户",
            })
            assert created.status_code == 201, created.text
            url = f"/api/reconciliations/{created.json()['id']}/resolve"
            payload = {"reason": "核对完成"}
        else:
            deposit = create_deposit(seeded_db, pool_id=pool.id, amount=Decimal("100"),
                                     paid_on=TODAY, actor="pytest")
            if action == "return":
                url = f"/api/deposits/{deposit.id}/returns"
                payload = {"amount": "30", "released_on": TODAY.isoformat()}
            else:
                url = f"/api/deposits/{deposit.id}/cancel"
                payload = {"reason": "登记错误", "cancelled_on": TODAY.isoformat()}
        create_order_form_field(seeded_db, order_type_code=scope, field_key="receipt",
                                label="操作凭据", required=True, actor="pytest")
        seeded_db.commit()
        missing = seeded_client.post(url, headers=headers, json=payload)
        assert missing.status_code == 422, missing.text
        assert "操作凭据" in missing.text
        saved = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {"receipt": "凭据A"}})
        assert saved.status_code == 200, saved.text
        assert saved.json()["form_extra"]["receipt"] == "凭据A"

    def test_reconciliation_endpoints_snapshot_and_resolve(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        flow = Cashflow(
            flow_no="CF-RECON-API-1",
            pool_id=invest.id,
            occurred_on=TODAY,
            category="OTHER",
            direction="IN",
            amount=Decimal("100.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(flow)
        seeded_db.flush()

        created = seeded_client.post(
            "/api/reconciliations",
            json={
                "pool_id": 1,
                "reconciled_on": TODAY.isoformat(),
                "account_label": "招商银行卡",
                "statement_balance": "90.00",
                "unmatched_flow_ids": [flow.id],
                "reason": "手续费未入账",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        item = created.json()
        assert item["system_balance"] == "100.00"
        assert item["difference"] == "-10.00"
        assert item["unmatched_flow_ids"] == [flow.id]
        assert item["operator"] == "admin"
        assert item["created_at"]

        listed = seeded_client.get(
            "/api/reconciliations",
            params={"pool_id": invest.id},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()[0]["id"] == item["id"]

        resolved = seeded_client.post(
            f"/api/reconciliations/{item['id']}/resolve",
            json={"reason": "已核实银行手续费"},
            headers=headers,
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == "RESOLVED"

    def test_balance_snapshot_endpoint(self, seeded_client, seeded_db, headers):
        """FIN-01-05：对账后可从只读端点查到当日固化余额。"""
        invest = _pool(seeded_db, "HJ_INVEST")
        seeded_db.add(
            Cashflow(
                flow_no="CF-SNAPSHOT-API-1",
                pool_id=invest.id,
                occurred_on=TODAY,
                category="OTHER",
                direction="IN",
                amount=Decimal("500.00"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()
        created = seeded_client.post(
            "/api/reconciliations",
            json={
                "pool_id": invest.id,
                "reconciled_on": TODAY.isoformat(),
                "account_label": "快照端点测试",
                "statement_balance": "500.00",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text

        snaps = seeded_client.get(
            "/api/balance-snapshots",
            params={"pool_id": invest.id},
            headers=headers,
        )
        assert snaps.status_code == 200, snaps.text
        rows = [s for s in snaps.json() if s["snapshot_on"] == TODAY.isoformat()]
        assert len(rows) == 1
        assert rows[0]["balance"] == "500.00"
        assert rows[0]["reconciliation_id"] == created.json()["id"]

    def test_manual_cashflow_review_and_reverse_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        created = seeded_client.post(
            "/api/cashflows",
            json={
                "pool_id": 1,
                "occurred_on": TODAY.isoformat(),
                "direction": "OUT",
                "category": "OPERATING",
                "amount": "25.00",
                "note": "接口测试费用",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        flow = created.json()
        assert "status" not in flow

        reversed_flow = seeded_client.post(
            f"/api/cashflows/{flow['id']}/reverse",
            json={"reversed_on": TODAY.isoformat(), "reason": "接口冲销"},
            headers=headers,
        )
        assert reversed_flow.status_code == 200, reversed_flow.text
        assert reversed_flow.json()["source_type"] == CashflowSourceType.REVERSAL.value
        assert reversed_flow.json()["source_id"] == flow["flow_no"]

    def test_order_cashflow_endpoint_links_income_without_creating_event(
        self, seeded_client, seeded_db, headers
    ):
        order_id = _active_order(seeded_db)
        created = seeded_client.post(
            f"/api/orders/{order_id}/cashflows",
            json={
                "pool_id": 1,
                "occurred_on": TODAY.isoformat(),
                "direction": "IN",
                "accounting_attribute": "SELF_REVENUE",
                "category": "OTHER",
                "amount": "100.00",
                "note": "补登记收入",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        flow = created.json()
        assert flow["order_id"] == order_id
        assert flow["direction"] == "IN"
        assert flow["category"] == "OTHER"
        assert seeded_db.scalar(
            select(Cashflow).where(Cashflow.id == flow["id"])
        ).source_type == CashflowSourceType.MANUAL.value

    def test_order_cashflow_uses_order_cashflow_field_rules(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        for scope, key, label in [
            ("REFUND", "receipt", "收支凭据"),
            ("FUNDFLOW", "business_note", "资金明细凭据"),
        ]:
            create_order_form_field(
                seeded_db, order_type_code=scope, field_key=key, label=label,
                required=True, actor="pytest",
            )
        seeded_db.commit()
        payload = {
            "pool_id": _pool(seeded_db, "HJ_INVEST").id,
            "occurred_on": TODAY.isoformat(), "direction": "OUT",
            "category": "OTHER", "amount": "25.00",
        }

        for url, order_link in [
            (f"/api/orders/{order_id}/cashflows", {}),
            ("/api/cashflows", {"order_id": order_id}),
        ]:
            bypass = seeded_client.post(url, headers=headers, json={
                **payload, **order_link, "form_extra_scope": "FUNDFLOW",
                "form_extra": {"business_note": "凭据"},
            })
            assert bypass.status_code == 422, bypass.text
            assert "收支凭据" in bypass.text

            for direction, attribute in [("OUT", "OTHER_EXPENSE"), ("IN", "OTHER_INCOME")]:
                created = seeded_client.post(url, headers=headers, json={
                    **payload, **order_link, "direction": direction, "form_extra": {"receipt": "凭据1"},
                })
                assert created.status_code == 201, created.text
                assert created.json()["form_extra"] == {"receipt": "凭据1"}
                assert created.json()["accounting_attribute"] == attribute

    def test_pool_scoped_finance_user_cannot_transfer_or_read_other_pool(
        self, seeded_client, seeded_db
    ):
        scoped_finance = CurrentUser.build(
            id=3,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped_finance)}"}

        transfer = seeded_client.post(
            "/api/transfers",
            json={
                "source_pool_id": 2,
                "target_pool_id": 1,
                "amount": "10.00",
                "occurred_on": TODAY.isoformat(),
            },
            headers=scoped_headers,
        )
        assert transfer.status_code == 404

        deposits = seeded_client.get(
            "/api/deposits", params={"pool_id": 2}, headers=scoped_headers
        )
        assert deposits.status_code == 200
        assert deposits.json() == []

    def test_scoped_finance_filters_unqualified_deposits_and_rebates(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )

        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}

        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
        )
        create_deposit(
            seeded_db, pool_id=2, amount=Decimal("20"), paid_on=TODAY, actor="pytest"
        )
        own_account = create_account(
            seeded_db,
            game_account="finance-own-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="scoped-finance",
        )
        own_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="scoped-finance",
            owner_id=9,
            account_id=own_account.id,
        )
        other_account = create_account(
            seeded_db,
            game_account="finance-other-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="other",
        )
        other_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
            account_id=other_account.id,
        )
        post_event(
            seeded_db, own_order.id, event_type="BUY", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest",
        )
        post_event(
            seeded_db, other_order.id, event_type="BUY", amount=Decimal("20"),
            occurred_on=TODAY, actor="pytest",
        )
        create_rebate(
            seeded_db, source_order_id=own_order.id, rebate_type="BUY", amount=Decimal("10"),
            collected_on=TODAY, actor="pytest"
        )
        create_rebate(
            seeded_db, source_order_id=other_order.id, rebate_type="BUY", amount=Decimal("20"),
            collected_on=TODAY, actor="pytest"
        )

        deposits = seeded_client.get("/api/deposits", headers=scoped_headers)
        assert deposits.status_code == 200, deposits.text
        assert {row["pool_id"] for row in deposits.json()} == {1}

        rebates = seeded_client.get("/api/rebates", headers=scoped_headers)
        assert rebates.status_code == 200, rebates.text
        assert [row["source_order_id"] for row in rebates.json()] == [own_order.id]

        create_other_pool = seeded_client.post(
            "/api/deposits",
            json={"pool_id": 2, "amount": "5", "paid_on": TODAY.isoformat()},
            headers=scoped_headers,
        )
        assert create_other_pool.status_code == 404

    def test_scoped_finance_services_enforce_pool_visibility_without_router_filters(
        self, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
        )
        create_deposit(
            seeded_db, pool_id=2, amount=Decimal("20"), paid_on=TODAY, actor="pytest"
        )

        deposits = list_deposits(seeded_db, user=scoped)
        cashflows, _ = list_cashflows(seeded_db, user=scoped)

        assert deposits
        assert {item.pool_id for item in deposits} == {1}
        assert cashflows
        assert {item["pool_id"] for item in cashflows} == {1}

    def test_scoped_cashflow_pagination_is_global_across_allowed_pools(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1, 2}),
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        seeded_db.add_all(
            [
                Cashflow(
                    flow_no="CF-PAGE-1", pool_id=1, occurred_on=date(2026, 10, 1),
                    category="OTHER", direction="IN", amount=Decimal("1"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-PAGE-2", pool_id=2, occurred_on=date(2026, 10, 2),
                    category="OTHER", direction="IN", amount=Decimal("2"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-PAGE-3", pool_id=1, occurred_on=date(2026, 10, 3),
                    category="OTHER", direction="IN", amount=Decimal("3"),
                    created_by="pytest", updated_by="pytest",
                ),
            ]
        )
        seeded_db.flush()

        response = seeded_client.get(
            "/api/cashflows",
            params={"limit": 2, "offset": 2},
            headers=scoped_headers,
        )
        assert response.status_code == 200, response.text
        assert [row["flow_no"] for row in response.json()["items"]] == ["CF-PAGE-1"]

    def test_cashflow_list_total_counts_all_matching_rows(
        self, seeded_client, seeded_db
    ):
        """分页响应中的 total 必须等于命中总数（而非本页条数），前端据此判断还有更多。"""
        scoped = CurrentUser.build(
            id=11,
            username="scoped-finance-total",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1, 2}),
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        seeded_db.add_all(
            [
                Cashflow(
                    flow_no="CF-TOTAL-1", pool_id=1, occurred_on=date(2026, 10, 1),
                    category="OTHER", direction="IN", amount=Decimal("1"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-TOTAL-2", pool_id=2, occurred_on=date(2026, 10, 2),
                    category="OTHER", direction="IN", amount=Decimal("2"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-TOTAL-3", pool_id=1, occurred_on=date(2026, 10, 3),
                    category="OTHER", direction="IN", amount=Decimal("3"),
                    created_by="pytest", updated_by="pytest",
                ),
            ]
        )
        seeded_db.flush()

        # 翻完所有页，收集 flow_no，验证 total 一致且不被截断。
        collected: list[str] = []
        offset = 0
        page_total = None
        while True:
            page = seeded_client.get(
                "/api/cashflows",
                params={"limit": 2, "offset": offset},
                headers=scoped_headers,
            )
            assert page.status_code == 200, page.text
            body = page.json()
            if page_total is None:
                page_total = body["total"]
            else:
                assert body["total"] == page_total
            collected.extend(row["flow_no"] for row in body["items"])
            if not body["items"] or len(collected) >= page_total:
                break
            offset += 2
        assert page_total is not None and page_total >= 3
        for expected in ("CF-TOTAL-1", "CF-TOTAL-2", "CF-TOTAL-3"):
            assert expected in collected

    def test_scoped_cashflow_order_filter_respects_order_owner(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        own_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="scoped-finance",
            owner_id=9,
        )
        foreign_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
        )
        seeded_db.add_all(
            [
                Cashflow(
                    flow_no="CF-SCOPE-OWN",
                    pool_id=1,
                    occurred_on=TODAY,
                    category="OTHER",
                    direction="IN",
                    amount=Decimal("10"),
                    order_id=own_order.id,
                    created_by="pytest",
                    updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-SCOPE-OTHER",
                    pool_id=1,
                    occurred_on=TODAY,
                    category="OTHER",
                    direction="IN",
                    amount=Decimal("20"),
                    order_id=foreign_order.id,
                    created_by="pytest",
                    updated_by="pytest",
                ),
            ]
        )
        seeded_db.flush()

        own = seeded_client.get(
            "/api/cashflows",
            params={"order_id": own_order.id},
            headers=headers,
        )
        foreign = seeded_client.get(
            "/api/cashflows",
            params={"order_id": foreign_order.id},
            headers=headers,
        )

        assert own.status_code == 200, own.text
        assert [row["flow_no"] for row in own.json()["items"]] == ["CF-SCOPE-OWN"]
        assert foreign.status_code == 200, foreign.text
        assert foreign.json()["items"] == []

    def test_scoped_operator_cannot_write_rebate_for_other_order(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        other_order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )

        response = seeded_client.post(
            "/api/rebates",
            json={
                "source_order_id": other_order.id,
                "amount": "10",
                "collected_on": TODAY.isoformat(),
                "rebate_type": "BUY",
            },
            headers=headers,
        )
        assert response.status_code == 404

    def test_rebate_service_respects_order_scope_when_user_is_supplied(
        self, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        foreign_order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )
        with pytest.raises(NotFound):
            create_rebate(
                seeded_db,
                source_order_id=foreign_order.id,
                amount=Decimal("10"),
                collected_on=TODAY,
                actor="operator",
                user=scoped,
            )

    def test_scoped_finance_cannot_attach_deposit_to_foreign_order(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        foreign_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
        )

        response = seeded_client.post(
            "/api/deposits",
            json={
                "pool_id": 1,
                "amount": "20",
                "paid_on": TODAY.isoformat(),
                "source_order_id": foreign_order.id,
            },
            headers=headers,
        )

        assert response.status_code == 404, response.text


    def test_create_transfer_posts_symmetric_internal_cashflows(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        create_cashflow(
            seeded_db,
            pool_id=invest.id,
            occurred_on=TODAY,
            direction="IN",
            accounting_attribute="SELF_REVENUE",
            category="OTHER",
            amount="200.00",
            actor="pytest",
        )
        source_before = pool_balance(seeded_db, invest.id)
        target_before = pool_balance(seeded_db, profit.id)

        response = seeded_client.post(
            "/api/transfers",
            json={
                "source_pool_id": invest.id,
                "target_pool_id": profit.id,
                "amount": "125.50",
                "occurred_on": TODAY.isoformat(),
                "note": "补充买号资金",
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        payload = response.json()
        assert payload["amount"] == "125.50"
        assert payload["operator"] == "admin"
        assert payload["created_at"]
        assert len(payload["cashflows"]) == 2
        assert {row["direction"] for row in payload["cashflows"]} == {"IN", "OUT"}
        assert len({row["source_id"] for row in payload["cashflows"]}) == 1
        source_balance = pool_balance(seeded_db, invest.id)
        target_balance = pool_balance(seeded_db, profit.id)
        assert source_balance["cash_balance"] == source_before["cash_balance"] - Decimal("125.50")
        assert target_balance["cash_balance"] == target_before["cash_balance"] + Decimal("125.50")
        assert source_balance["transfer_in"] == Decimal("0.00")
        assert source_balance["transfer_out"] == Decimal("125.50")
        assert target_balance["transfer_in"] == Decimal("125.50")
        assert target_balance["transfer_out"] == Decimal("0.00")
        assert source_balance["cash_balance"] + target_balance["cash_balance"] == (
            source_before["cash_balance"] + target_before["cash_balance"]
        )

    def test_transfer_service_respects_pool_scope(self, seeded_db):
        scoped_finance = CurrentUser.build(
            id=3,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        with pytest.raises(NotFound, match="资金账户不存在"):
            create_transfer(
                seeded_db,
                source_pool_id=2,
                target_pool_id=1,
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="scoped-finance",
                user=scoped_finance,
            )

    def test_repair_unpaired_transfer_creates_only_missing_side(
        self, seeded_db
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        seeded_db.add(
            Cashflow(
                flow_no="TR-REPAIR-OUT",
                pool_id=invest.id,
                occurred_on=TODAY,
                category="TRANSFER",
                direction="OUT",
                amount=Decimal("80"),
                source_type=CashflowSourceType.TRANSFER.value,
                source_id="TR-REPAIR",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()

        result = repair_transfer(
            seeded_db,
            "TR-REPAIR",
            counterpart_pool_id=profit.id,
            actor="finance",
            reason="补齐历史单边划转",
            operator_user_ids=[1],
        )

        assert len(result["cashflows"]) == 2
        rows = seeded_db.scalars(
            select(Cashflow).where(
                Cashflow.source_type == CashflowSourceType.TRANSFER.value,
                Cashflow.source_id == "TR-REPAIR",
            )
        ).all()
        assert {row.pool_id for row in rows} == {invest.id, profit.id}
        assert {row.direction for row in rows} == {"IN", "OUT"}
        assert {row.amount for row in rows} == {Decimal("80.00")}

        with pytest.raises(Validation, match="已完整"):
            repair_transfer(
                seeded_db,
                "TR-REPAIR",
                counterpart_pool_id=profit.id,
                actor="finance",
                reason="重复修复",
            )

    def test_repair_transfer_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        seeded_db.add(
            Cashflow(
                flow_no="TR-REPAIR-API-OUT",
                pool_id=invest.id,
                occurred_on=TODAY,
                category="TRANSFER",
                direction="OUT",
                amount=Decimal("45"),
                source_type=CashflowSourceType.TRANSFER.value,
                source_id="TR-REPAIR-API",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()

        response = seeded_client.post(
            "/api/transfers/TR-REPAIR-API/repair",
            json={
                "counterpart_pool_id": profit.id,
                "reason": "补齐对端流水",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert len(response.json()["cashflows"]) == 2


    def test_list_deposits_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest", source_order_id=order_id,
            expected_release_on=TODAY.replace(day=20), note="押金业务备注",
        )
        response = seeded_client.get("/api/deposits", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1
        assert "deposit_no" not in response.json()[0]
        assert response.json()[0]["source_order_id"] == order_id
        assert response.json()[0]["expected_release_on"] == "2026-10-20"
        assert response.json()[0]["note"] == "押金业务备注"
        assert response.json()[0]["operator"] == "pytest"
        assert response.json()[0]["created_at"]

    def test_deposit_loss_endpoint_returns_operating_cashflow(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
        )
        response = seeded_client.post(
            f"/api/deposits/{deposit.id}/losses",
            json={
                "amount": "40",
                "lost_on": TODAY.isoformat(),
                "category": "OPERATING_COST",
                "reason": "对方违约扣除",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["category"] == "OPERATING_COST"
        assert response.json()["source"] == "DEPOSIT"

    def test_list_rebates_endpoint(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY", amount=Decimal("100"),
            collected_on=TODAY, actor="pytest", channel="买号返点",
            note="回收买号返点",
        )
        response = seeded_client.get("/api/rebates", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1
        assert response.json()[0]["rebate_no"].startswith("HS")
        assert "rebate_group_no" not in response.json()[0]
        assert response.json()[0]["channel"] == "买号返点"
        assert response.json()[0]["note"] == "回收买号返点"
        assert response.json()[0]["operator"] == "pytest"
        assert response.json()[0]["created_at"]

    def test_create_rebate_endpoint(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        response = seeded_client.post(
            "/api/rebates",
            json={
                "source_order_id": order_id,
                "amount": "300",
                "collected_on": TODAY.isoformat(),
                "rebate_type": "BUY",
                "channel": "WECHAT",
            },
            headers=headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["source_order_id"] == order_id
        assert response.json()["rebate_type"] == "BUY"
        assert response.json()["channel"] == "WECHAT"


