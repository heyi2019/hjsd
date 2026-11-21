"""API-01 / CALC-01 工作台总览接口、个人收益与周期汇总。"""

from datetime import date
from decimal import Decimal


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

    def fake_order_status_counts(session, **kwargs):
        calls.append(kwargs)
        return {"COMPLETED": 1}

    monkeypatch.setattr("app.workbench.overview.service.order_status_counts", fake_order_status_counts)

    response = seeded_client.get("/api/workbench/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert len(calls) == 2
    expected = {"trade_date_from": date(2026, 11, 16), "trade_date_to": date(2026, 12, 15)}
    assert calls[0]["trade_date_from"] == expected["trade_date_from"]
    assert calls[0]["trade_date_to"] == expected["trade_date_to"]
    assert calls[0].get("mine", False) is False
    assert calls[1]["trade_date_from"] == expected["trade_date_from"]
    assert calls[1]["trade_date_to"] == expected["trade_date_to"]
    assert calls[1]["mine"] is True
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
