"""CASHFLOW-01 工作室收支面板汇总契约（FIN-04 /cashflows/studio-summary）。

前端 `pools/StudioExpensePanel.tsx` 原先发两次 `/cashflows`（收入一次、支出一次），
自己按 `source === "OTHER"` 过滤、再用 `reduce + toFixed` 算出已入账收入/支出/净额。
这套口径散在组件里有三个问题：`limit` 截断会少算、浮点累加、属性配对规则改一次就漂。

汇总搬后端后，这里守住：
1. 流水登记即生效，直接进入经营口径；
2. 只算手工登记（返点/押金/划转/订单事件流水都不算工作室收支）；
3. 支出认 OPERATING_EXPENSE、收入认 SELF_REVENUE，不能互相串；
4. 汇总不受 items 的 limit 影响，净额由后端算。
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.domain.foundation import AuditLog, Pool
from app.domain.trade import OrderFormField
from app.business.form_fields import create_order_form_field
from app.funds.cashflows import create_cashflow, reverse_cashflow

TODAY = date(2026, 10, 4)


def _pool(seeded_db) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    return pool


def _flow(
    seeded_db,
    *,
    direction: str,
    attribute: str,
    amount: str,
    category: str = "房租",
    note: str = "memo",
):
    """手工登记一笔工作室收支：nature 与方向对齐，属性由调用方指定。"""
    return create_cashflow(
        seeded_db,
        pool_id=_pool(seeded_db).id,
        occurred_on=TODAY,
        direction=direction,
        ledger_type="STUDIO",
        accounting_attribute=attribute,
        category=category,
        amount=Decimal(amount),
        actor="pytest",
        note=note,
    )


def _summary(seeded_client, headers, **params) -> dict:
    response = seeded_client.get(
        "/api/cashflows/studio-summary", headers=headers, params=params
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("editing", [False, True])
def test_studio_conditional_field_tracks_direction_and_preserves_history(seeded_client, seeded_db, headers, editing):
    if editing:
        flow = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="120")
        flow.form_extra = {"other_history": "历史字段"}
        seeded_db.flush()
        url = f"/api/cashflows/{flow.id}"
    else:
        url = "/api/cashflows"
    direction = seeded_db.scalar(select(OrderFormField).where(
        OrderFormField.order_type_code == "STUDIOEXP", OrderFormField.field_key == "direction",
    ))
    if direction is None:
        direction = create_order_form_field(seeded_db, order_type_code="STUDIOEXP", field_key="direction",
                                            label="收支", actor="pytest")
        direction.is_custom = False
        seeded_db.flush()
    create_order_form_field(
        seeded_db, order_type_code="STUDIOEXP", field_key="receipt", label="支出凭据", actor="pytest",
        required_when={"field": "direction", "op": "eq", "values": ["OUT"]},
    )
    seeded_db.commit()
    payload = {"pool_id": _pool(seeded_db).id, "occurred_on": TODAY.isoformat(),
               "ledger_type": "STUDIO", "direction": "OUT", "accounting_attribute": "OPERATING_EXPENSE",
               "category": "房租", "amount": "120"}
    request = seeded_client.put if editing else seeded_client.post
    missing = request(url, headers=headers, json=payload)
    assert missing.status_code == 422, missing.text
    assert "支出凭据" in missing.text
    spoofed = request(url, headers=headers, json={**payload, "form_extra": {"direction": "IN"}})
    assert spoofed.status_code == 422, spoofed.text
    assert "支出凭据" in spoofed.text
    saved = request(url, headers=headers, json={**payload, "form_extra": {"receipt": "凭据A"}})
    assert saved.status_code == (200 if editing else 201), saved.text
    assert saved.json()["form_extra"]["receipt"] == "凭据A"
    if editing:
        assert saved.json()["form_extra"]["other_history"] == "历史字段"
    income = request(url, headers=headers, json={
        **payload, "direction": "IN", "accounting_attribute": "SELF_REVENUE", "category": "货款", "form_extra": {},
    })
    assert income.status_code == (200 if editing else 201), income.text
    assert "receipt" not in (income.json()["form_extra"] or {})
    if editing:
        assert income.json()["form_extra"]["other_history"] == "历史字段"


def test_summary_counts_only_manual_flows(seeded_client, seeded_db, headers):
    expense = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="300")
    income = _flow(seeded_db, direction="IN", attribute="SELF_REVENUE", amount="800")
    # 模拟历史异常数据：保留对旧记录的查询隔离验证。
    legacy_rebate = _flow(seeded_db, direction="IN", attribute="SELF_REVENUE", amount="50")
    legacy_rebate.category = "REBATE"
    # 历史属性不配对：收入 + 运营消耗，不能进收入合计。
    legacy_mismatch = _flow(seeded_db, direction="IN", attribute="SELF_REVENUE", amount="70")
    legacy_mismatch.accounting_attribute = "OPERATING_EXPENSE"
    seeded_db.flush()

    payload = _summary(seeded_client, headers)

    numbers = {item["flow_no"] for item in payload["items"]}
    assert expense.flow_no in numbers
    assert income.flow_no in numbers
    assert payload["count"] == 2
    assert Decimal(payload["expense"]) == Decimal("300.00")
    assert Decimal(payload["income"]) == Decimal("800.00")
    assert Decimal(payload["net"]) == Decimal("500.00")


def test_new_flow_appears_in_items_and_summary(seeded_client, seeded_db, headers):
    flow = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="120")

    payload = _summary(seeded_client, headers)

    assert [item["flow_no"] for item in payload["items"]] == [flow.flow_no]
    assert Decimal(payload["expense"]) == Decimal("120.00")
    assert Decimal(payload["net"]) == Decimal("-120.00")


def test_studio_create_rejects_invisible_flows_and_defaults_income_attribute(seeded_client, seeded_db, headers):
    payload = {"pool_id": _pool(seeded_db).id, "occurred_on": TODAY.isoformat(),
               "ledger_type": "STUDIO", "direction": "IN", "category": "货款", "amount": "100"}
    for changes in (
        {"accounting_attribute": "OPERATING_EXPENSE"},
        {"direction": "OUT", "accounting_attribute": "SELF_REVENUE"},
        {"category": "REBATE", "accounting_attribute": "SELF_REVENUE"},
    ):
        response = seeded_client.post("/api/cashflows", headers=headers, json={**payload, **changes})
        assert response.status_code == 422, response.text
    assert _summary(seeded_client, headers)["count"] == 0
    response = seeded_client.post("/api/cashflows", headers=headers, json=payload)
    assert response.status_code == 201, response.text
    assert response.json()["accounting_attribute"] == "SELF_REVENUE"
    summary = _summary(seeded_client, headers)
    assert [item["flow_no"] for item in summary["items"]] == [response.json()["flow_no"]]
    assert Decimal(summary["income"]) == Decimal("100.00")


def test_studio_create_and_edit_use_studio_custom_field_rules(seeded_client, seeded_db, headers):
    for scope, key, label in [("STUDIOEXP", "studio_note", "工作室凭据"), ("FUNDFLOW", "business_note", "业务凭据")]:
        create_order_form_field(seeded_db, order_type_code=scope, field_key=key, label=label, required=True, actor="pytest")
    seeded_db.commit()
    payload = {
        "pool_id": _pool(seeded_db).id, "occurred_on": TODAY.isoformat(),
        "direction": "OUT", "ledger_type": "STUDIO", "accounting_attribute": "OPERATING_EXPENSE",
        "category": "房租", "amount": "120.00",
    }
    missing = seeded_client.post("/api/cashflows", headers=headers, json=payload)
    assert missing.status_code == 422, missing.text
    assert "工作室凭据" in missing.text
    bypass_create = seeded_client.post("/api/cashflows", headers=headers, json={**payload, "form_extra_scope": "FUNDFLOW", "form_extra": {"business_note": "凭据2"}})
    assert bypass_create.status_code == 422, bypass_create.text
    assert "工作室凭据" in bypass_create.text
    created = seeded_client.post("/api/cashflows", headers=headers, json={**payload, "form_extra": {"studio_note": "凭据1"}})
    assert created.status_code == 201, created.text
    assert created.json()["form_extra"] == {"studio_note": "凭据1"}
    flow_id = created.json()["id"]
    bypass = seeded_client.put(f"/api/cashflows/{flow_id}", headers=headers, json={**payload, "form_extra_scope": "FUNDFLOW", "form_extra": {"business_note": "凭据2"}})
    assert bypass.status_code == 422, bypass.text
    saved = seeded_client.put(f"/api/cashflows/{flow_id}", headers=headers, json={**payload, "form_extra": {"studio_note": "凭据3"}})
    assert saved.status_code == 200, saved.text
    assert saved.json()["form_extra"] == {"studio_note": "凭据3"}


def test_studio_custom_fields_round_trip_through_list_and_edit(seeded_client, seeded_db, headers):
    create_order_form_field(seeded_db, order_type_code="STUDIOEXP", field_key="receipt",
                            label="凭据", required=False, actor="pytest")
    seeded_db.commit()
    payload = {"pool_id": _pool(seeded_db).id, "occurred_on": TODAY.isoformat(),
               "ledger_type": "STUDIO", "direction": "OUT", "accounting_attribute": "OPERATING_EXPENSE",
               "category": "房租", "amount": "120", "form_extra": {"receipt": "单据A"}}
    created = seeded_client.post("/api/cashflows", headers=headers, json=payload)
    assert created.status_code == 201, created.text
    item = _summary(seeded_client, headers)["items"][0]
    assert item["form_extra"] == {"receipt": "单据A"}
    listing = seeded_client.get("/api/cashflows", headers=headers, params={"keyword": item["flow_no"]})
    assert listing.status_code == 200, listing.text
    assert listing.json()["items"][0]["form_extra"] == {"receipt": "单据A"}
    saved = seeded_client.put(f"/api/cashflows/{item['id']}", headers=headers,
                              json={**payload, "amount": "150", "form_extra": item["form_extra"]})
    assert saved.status_code == 200, saved.text
    assert saved.json()["form_extra"] == {"receipt": "单据A"}
    assert _summary(seeded_client, headers)["items"][0]["form_extra"] == {"receipt": "单据A"}


def test_edit_studio_cashflow_saves_operator_and_rejects_invalid_operator(seeded_client, seeded_db, headers):
    flow = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="120")
    payload = {
        "pool_id": flow.pool_id,
        "occurred_on": TODAY.isoformat(),
        "direction": "OUT",
        "ledger_type": "STUDIO",
        "accounting_attribute": "OPERATING_EXPENSE",
        "category": "房租",
        "amount": "150.00",
        "note": "调整",
        "operator_user_ids": [1, 2],
    }
    response = seeded_client.put(f"/api/cashflows/{flow.id}", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["operator_user_ids"] == [1, 2]
    assert _summary(seeded_client, headers)["items"][0]["operator_user_ids"] == [1, 2]
    audit = seeded_db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "cashflow", AuditLog.entity_id == flow.flow_no,
        AuditLog.action == "CASHFLOW_UPDATE",
    ))
    assert audit is not None
    assert audit.before_json["operator_user_ids"] is None
    assert audit.after_json["operator_user_ids"] == [1, 2]

    response = seeded_client.put(
        f"/api/cashflows/{flow.id}", headers=headers,
        json={**payload, "operator_user_ids": [999999], "amount": "999"},
    )
    assert response.status_code == 422, response.text
    saved = _summary(seeded_client, headers)["items"][0]
    assert saved["operator_user_ids"] == [1, 2]
    assert Decimal(saved["amount"]) == Decimal("150.00")


def test_reversed_flag_survives_date_direction_and_page_filters(seeded_client, seeded_db, headers):
    reversed_flow = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="100")
    live_flow = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="200")
    reverse_cashflow(seeded_db, reversed_flow.id, reversed_on=TODAY + timedelta(days=1), actor="pytest", reason="登记有误")
    params = {"occurred_from": TODAY.isoformat(), "occurred_to": TODAY.isoformat()}
    studio = _summary(seeded_client, headers, **params)
    by_no = {item["flow_no"]: item for item in studio["items"]}
    assert by_no[reversed_flow.flow_no]["is_reversed"] is True
    assert by_no[live_flow.flow_no]["is_reversed"] is False
    listing = seeded_client.get("/api/cashflows", headers=headers, params={**params, "direction": "OUT", "keyword": reversed_flow.flow_no, "limit": 1})
    assert listing.status_code == 200, listing.text
    assert listing.json()["items"][0]["is_reversed"] is True


def test_reversal_offsets_expense_and_income(seeded_client, seeded_db, headers):
    """工作室手工收支冲销后，冲销流水应留在工作室账簿并反向抵消，净额归零。"""
    expense = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="100")
    income = _flow(seeded_db, direction="IN", attribute="SELF_REVENUE", amount="250")

    before = _summary(seeded_client, headers)
    assert Decimal(before["expense"]) == Decimal("100.00")
    assert Decimal(before["income"]) == Decimal("250.00")

    rev_expense = reverse_cashflow(
        seeded_db, expense.id, reversed_on=TODAY, actor="pytest", reason="支出录错冲销"
    )
    rev_income = reverse_cashflow(
        seeded_db, income.id, reversed_on=TODAY, actor="pytest", reason="收入录错冲销"
    )
    # 冲销流水继承原流水账簿（STUDIO），而不是落到默认 BUSINESS。
    assert rev_expense.ledger_type == "STUDIO"
    assert rev_income.ledger_type == "STUDIO"

    after = _summary(seeded_client, headers)
    assert Decimal(after["expense"]) == Decimal("0.00")
    assert Decimal(after["income"]) == Decimal("0.00")
    assert Decimal(after["net"]) == Decimal("0.00")
    # 明细与汇总同源：两条原流水 + 两条冲销都计入笔数（毛额呈现）。
    numbers = {item["flow_no"] for item in after["items"]}
    assert {expense.flow_no, income.flow_no, rev_expense.flow_no, rev_income.flow_no} <= numbers
    assert after["count"] == 4


def test_category_filter_includes_reversals_of_that_category(seeded_client, seeded_db, headers):
    rent = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="100", category="房租")
    sale = _flow(seeded_db, direction="IN", attribute="SELF_REVENUE", amount="250", category="货款")
    rent_reverse = reverse_cashflow(seeded_db, rent.id, reversed_on=TODAY + timedelta(days=1), actor="pytest", reason="冲销房租")
    sale_reverse = reverse_cashflow(seeded_db, sale.id, reversed_on=TODAY + timedelta(days=1), actor="pytest", reason="冲销货款")

    rent_result = _summary(seeded_client, headers, category="房租")
    assert {item["flow_no"] for item in rent_result["items"]} == {rent.flow_no, rent_reverse.flow_no}
    assert rent_result["count"] == 2
    assert Decimal(rent_result["expense"]) == Decimal("0.00")
    sale_result = _summary(seeded_client, headers, category="货款")
    assert {item["flow_no"] for item in sale_result["items"]} == {sale.flow_no, sale_reverse.flow_no}
    assert Decimal(sale_result["income"]) == Decimal("0.00")
    next_day = _summary(seeded_client, headers, category="房租", occurred_from=(TODAY + timedelta(days=1)).isoformat())
    assert [item["flow_no"] for item in next_day["items"]] == [rent_reverse.flow_no]
    assert Decimal(next_day["expense"]) == Decimal("-100.00")


def test_business_reversal_not_in_studio_scope(seeded_client, seeded_db, headers):
    """业务账簿手工流水被冲销，冲销流水不进工作室面板（账簿隔离）。"""
    biz = create_cashflow(
        seeded_db, pool_id=_pool(seeded_db).id, occurred_on=TODAY, direction="OUT",
        ledger_type="BUSINESS", accounting_attribute="OPERATING_EXPENSE",
        category="房租", amount=Decimal("300"), actor="pytest",
    )
    rev = reverse_cashflow(
        seeded_db, biz.id, reversed_on=TODAY, actor="pytest", reason="业务支出冲销"
    )
    assert rev.ledger_type == "BUSINESS"

    payload = _summary(seeded_client, headers)
    assert payload["items"] == []
    assert Decimal(payload["expense"]) == Decimal("0.00")
    assert Decimal(payload["net"]) == Decimal("0.00")


def test_summary_ignores_item_limit(seeded_client, seeded_db, headers):
    for index in range(3):
        _flow(
            seeded_db,
            direction="OUT",
            attribute="OPERATING_EXPENSE",
            amount="100",
            note=f"第{index}笔",
        )

    payload = _summary(seeded_client, headers, limit=1)

    assert len(payload["items"]) == 1
    # 汇总走 SQL SUM/COUNT，不吃 limit：三条 100 仍是 300，笔数仍是 3（不是当页 1 条）。
    assert Decimal(payload["expense"]) == Decimal("300.00")
    assert payload["count"] == 3


def test_summary_paginates_items_without_changing_totals(seeded_client, seeded_db, headers):
    first = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="100")
    second = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="200")
    _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="300")
    page = _summary(seeded_client, headers, limit=1, offset=1)
    assert [item["flow_no"] for item in page["items"]] == [second.flow_no]
    assert page["count"] == 3
    assert Decimal(page["expense"]) == Decimal("600.00")
    last = _summary(seeded_client, headers, limit=1, offset=2)
    assert [item["flow_no"] for item in last["items"]] == [first.flow_no]


def test_summary_excludes_order_event_flows(seeded_client, seeded_db, headers):
    from app.business.create import create_order
    from app.business.events import post_event
    from app.business.stocks.profile import create_account

    account = create_account(
        seeded_db,
        game_account="studio-summary-acc",
        actor="pytest",
        business_mode="SELF",
        inventory_type="RECOVERY",
    )
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    # 订单事件派生的 BUY 流水挂在 order_event_id 上，source 是 ORDER_EVENT。
    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("500"),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=_pool(seeded_db).id,
    )

    payload = _summary(seeded_client, headers)

    assert payload["items"] == []
    assert Decimal(payload["expense"]) == Decimal("0.00")


def test_summary_excludes_order_plain_cashflows(seeded_client, seeded_db, headers):
    """订单普通资金流水（挂 order_id 但无事件/押金/划转）属性命中也不算工作室收支。"""
    from app.business.create import create_order
    from app.business.stocks.profile import create_account

    account = create_account(
        seeded_db,
        game_account="studio-summary-plain-acc",
        actor="pytest",
        business_mode="SELF",
        inventory_type="RECOVERY",
    )
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    create_cashflow(
        seeded_db,
        pool_id=_pool(seeded_db).id,
        occurred_on=TODAY,
        direction="OUT",
        accounting_attribute="OPERATING_EXPENSE",
        ledger_type="BUSINESS",
        category="房租",
        amount=Decimal("450"),
        actor="pytest",
        order_id=order.id,
        note="订单普通支出",
    )
    # 真正的工作室手工支出必须仍在：确认过滤只排订单流水、不误伤手工登记。
    _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="90")

    payload = _summary(seeded_client, headers)

    amounts = {Decimal(item["amount"]) for item in payload["items"]}
    assert Decimal("450.00") not in amounts
    assert Decimal("90.00") in amounts
    assert Decimal(payload["expense"]) == Decimal("90.00")
    assert Decimal(payload["net"]) == Decimal("-90.00")


def test_pool_ids_filter(seeded_client, seeded_db, headers):
    other = Pool(
        code="STUDIO-OTHER",
        name="另一工作室",
        pool_type="OPERATING",
        status="ACTIVE",
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(other)
    seeded_db.commit()

    mine = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="100")
    create_cashflow(
        seeded_db,
        pool_id=other.id,
        occurred_on=TODAY,
        direction="OUT",
        accounting_attribute="OPERATING_EXPENSE",
        category="房租",
        amount=Decimal("900"),
        actor="pytest",
        note="别的池",
    )

    payload = _summary(seeded_client, headers, pool_ids=str(mine.pool_id))

    assert payload["count"] == 1
    assert Decimal(payload["expense"]) == Decimal("100.00")


def test_pool_ids_must_be_integers(seeded_client, headers):
    response = seeded_client.get(
        "/api/cashflows/studio-summary",
        headers=headers,
        params={"pool_ids": "1,abc"},
    )

    assert response.status_code == 422, response.text
