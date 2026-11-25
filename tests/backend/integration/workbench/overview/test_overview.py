"""API-01 / CALC-01 工作台总览接口、个人收益与周期汇总。"""

from datetime import date
from decimal import Decimal


def test_workbench_order_counts_preserve_scope_in_one_aggregate(seeded_db):
    """总量与本人操作量口径不同，但不应重复扫描订单。"""
    from sqlalchemy import event

    from app.business.orders.queries import workbench_order_counts
    from app.core.security import CurrentUser
    from app.domain.trade import Order, OrderEvent
    from app.domain.users import User
    from app.workbench.overview.service import workbench_summary

    user = CurrentUser.build(id=2, username="operator", roles=["OPERATOR"], owner_scope="SELF")
    orders = [
        Order(order_no="HS-SCOPE-1", order_type="HS", trade_date=date(2026, 11, 20), owner_id=2, form_extra={"business_responsible_ids": [2]}),
        Order(order_no="HS-SCOPE-2", order_type="HS", trade_date=date(2026, 11, 20), owner_id=2, form_extra={"business_responsible_ids": [1]}),
        Order(order_no="HS-SCOPE-3", order_type="HS", trade_date=date(2026, 11, 20), owner_id=1, form_extra={"business_responsible_ids": [2]}),
        Order(order_no="HS-SCOPE-4", order_type="HS", trade_date=date(2026, 11, 20), owner_id=1, form_extra={"business_responsible_ids": [1]}),
        Order(order_no="HS-SCOPE-5", order_type="HS", trade_date=date(2026, 11, 20), owner_id=1),
        Order(order_no="HS-SCOPE-6", order_type="HS", trade_date=date(2026, 10, 20), owner_id=2, form_extra={"business_responsible_ids": [2]}),
    ]
    orders[1].status = "COMPLETED"
    orders[3].status = "CANCELLED"
    seeded_db.add_all(orders)
    seeded_db.flush()
    seeded_db.add(OrderEvent(
        event_no="EV-SCOPE-1", order_id=orders[4].id, event_type="SELL", amount=Decimal("1.00"),
        occurred_on=date(2026, 11, 20), is_posted=True, operator_user_ids=[2],
    ))
    seeded_db.flush()
    statements = []

    def record(_conn, _cursor, statement, _params, _context, _many):
        statements.append(" ".join(statement.lower().split()))

    connection = seeded_db.connection()
    event.listen(connection, "before_cursor_execute", record)
    try:
        result = workbench_summary(seeded_db, user=user, from_date=date(2026, 11, 1), to_date=date(2026, 11, 30))
    finally:
        event.remove(connection, "before_cursor_execute", record)

    assert result["orders"]["total_count"] == 2
    assert result["personal_orders"] == 3
    count_queries = [sql for sql in statements if sql.startswith(("select orders.status, count(orders.id)", "select count(orders.id)"))]
    assert len(count_queries) == 1

    period = {"trade_date_from": date(2026, 11, 1), "trade_date_to": date(2026, 11, 30)}
    admin = CurrentUser.build(id=2, username="admin", roles=["ADMIN"], owner_scope="ALL")
    assert workbench_order_counts(seeded_db, user=admin, **period) == (5, 3)
    seeded_db.get(User, 1).team_ids = [42]
    seeded_db.get(User, 2).team_ids = [42]
    seeded_db.flush()
    team = CurrentUser.build(id=2, username="operator", roles=["OPERATOR"], owner_scope="TEAM", team_ids=[42])
    assert workbench_order_counts(seeded_db, user=team, **period) == (5, 3)
    assert workbench_order_counts(seeded_db, user=team, trade_date_from=date(2027, 1, 1)) == (0, 0)


def test_workbench_summary_exposes_one_backend_aggregate(seeded_client, headers):
    response = seeded_client.get("/api/workbench/summary", headers=headers)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert set(payload) == {
        "period",
        "orders",
        "personal_orders",
        "personal_customers",
        "personal_earnings",
        "inventory",
        "installments",
    }
    assert set(payload["period"]) == {"from", "to"}
    assert set(payload["orders"]) == {"total_count"}
    assert seeded_client.get("/api/stocks/dashboard-summary", headers=headers).status_code in {404, 405}



def test_workbench_personal_earnings_uses_commission_profit_base(
    seeded_client, headers, monkeypatch
):
    monkeypatch.setattr(
        "app.workbench.overview.service.personal_commission_total",
        lambda *args, **kwargs: Decimal("123.45"),
    )

    response = seeded_client.get("/api/workbench/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["personal_earnings"] == "123.45"


def test_workbench_order_cards_use_the_current_period(seeded_client, seeded_db, headers, monkeypatch):
    calls = []
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 11, 20)

    monkeypatch.setattr("app.workbench.overview.service.date", FixedDate)

    def fake_workbench_order_counts(session, **kwargs):
        calls.append(kwargs)
        return 1, 1

    monkeypatch.setattr("app.workbench.overview.service.workbench_order_counts", fake_workbench_order_counts)

    response = seeded_client.get("/api/workbench/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert len(calls) == 1
    expected = {"trade_date_from": date(2026, 11, 16), "trade_date_to": date(2026, 12, 15)}
    assert calls[0]["trade_date_from"] == expected["trade_date_from"]
    assert calls[0]["trade_date_to"] == expected["trade_date_to"]
    calls.clear()
    response = seeded_client.get("/api/workbench/summary", headers=headers, params={"from": "2026-01-02", "to": "2026-02-04"})
    assert response.status_code == 200, response.text
    assert response.json()["period"] == {"from": "2026-01-02", "to": "2026-02-04"}
    assert all(call["trade_date_from"] == date(2026, 1, 2) and call["trade_date_to"] == date(2026, 2, 4) for call in calls)
    assert seeded_client.get("/api/workbench/summary", headers=headers, params={"from": "2026-02-04", "to": "2026-01-02"}).status_code == 422
    assert seeded_client.get("/api/workbench/summary", headers=headers, params={"from": "2026-01-02"}).status_code == 422
    calls.clear()
    response = seeded_client.get("/api/workbench/summary", headers=headers, params={"all_time": "true"})
    assert response.status_code == 200, response.text
    assert response.json()["period"] is None
    assert all(call["trade_date_from"] is None and call["trade_date_to"] is None for call in calls)
    assert seeded_client.get("/api/workbench/summary", headers=headers, params={"all_time": "true", "from": "2026-01-02", "to": "2026-02-04"}).status_code == 422
    from app.domain.options import OptionSet
    setting = OptionSet(code="BUSINESS_PERIOD", label="当期设置", group="BUSINESS", editable=False, options=[{"value": "start_day", "label": "10"}], created_by="pytest", updated_by="pytest")
    seeded_db.add(setting)
    seeded_db.flush()
    response = seeded_client.get("/api/workbench/summary", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["period"] == {"from": "2026-11-10", "to": "2026-12-09"}
    from app.shared.business_period import business_period
    assert business_period(date(2028, 2, 28), 31) == (date(2028, 1, 31), date(2028, 2, 28))
    assert business_period(date(2028, 2, 29), 31) == (date(2028, 2, 29), date(2028, 3, 30))
