"""finance 押金与返点契约测试（DEP-01 / REB-01）。

与 test_m2.py / test_bughunt.py 的分工：既有文件已覆盖押金占用/部分退回、
超退校验、返点记录与到账主路径；本文件补押金退还 404、押金列表与持有合计、
来源订单不存在、结算 404 与手续费超额、返点列表过滤，以及 4 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.foundation import Pool
from app.domain.trade import Cashflow
from app.finance import service
from app.orders import service as orders_service

TODAY = date(2026, 10, 4)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool


def _active_order(seeded_db) -> int:
    order = orders_service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
    )
    orders_service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    return order.id


class TestDepositQueries:
    def test_deposit_source_order_must_exist(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")

        with pytest.raises(NotFound, match="来源订单"):
            service.create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                actor="pytest",
                source_order_id=999999,
            )

    def test_return_deposit_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.return_deposit(
                seeded_db, 999999, amount=Decimal("10"), released_on=TODAY, actor="pytest"
            )

    def test_list_deposits_filters_by_pool(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        service.create_deposit(
            seeded_db, pool_id=profit.id, amount=Decimal("500"), paid_on=TODAY,
            actor="pytest",
        )
        by_pool = service.list_deposits(seeded_db, pool_id=profit.id)
        assert [item.pool_id for item in by_pool] == [profit.id]
        assert len(service.list_deposits(seeded_db)) == 2

    def test_deposit_held_total_by_pool_and_overall(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        first = service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        service.create_deposit(
            seeded_db, pool_id=profit.id, amount=Decimal("500"), paid_on=TODAY,
            actor="pytest",
        )
        assert service.deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "1000.00"
        )
        assert service.deposit_held_total(seeded_db) == Decimal("1500.00")

        service.return_deposit(
            seeded_db, first.id, amount=Decimal("400"), released_on=TODAY, actor="pytest"
        )
        # 持有合计按「已付 - 已退」计算，退还后即时下降
        assert service.deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "600.00"
        )


class TestRebateGuards:
    def test_rebate_rate_must_be_percentage_and_fee_non_negative(self, seeded_db):
        order_id = _active_order(seeded_db)

        with pytest.raises(Validation, match="返点比例"):
            service.create_rebate(
                seeded_db,
                source_order_id=order_id,
                base_amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
                rate=Decimal("100.01"),
            )

        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        with pytest.raises(Validation, match="不能为负数"):
            service.settle_rebate(
                seeded_db,
                record.id,
                gross_amount=Decimal("10"),
                settled_on=TODAY,
                pool_id=_pool(seeded_db, "HJ_INVEST").id,
                actor="pytest",
                platform_fee=Decimal("-1"),
            )

    def test_rebate_is_settled_by_gross_amount_not_net_amount(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )

        settlement = service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=invest.id,
            actor="pytest",
            platform_fee=Decimal("10"),
        )

        seeded_db.refresh(record)
        assert settlement.net_amount == Decimal("90.00")
        assert record.status == "SETTLED"

    def test_source_order_notfound(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_rebate(
                seeded_db, source_order_id=999999, base_amount=Decimal("100"),
                collected_on=TODAY, actor="pytest",
            )
        assert "来源订单" in str(exc.value)

    def test_settle_notfound(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(NotFound):
            service.settle_rebate(
                seeded_db, 999999, gross_amount=Decimal("100"), settled_on=TODAY,
                pool_id=invest.id, actor="pytest",
            )

    def test_fee_cannot_exceed_gross(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db, source_order_id=order_id, base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest", rate=Decimal("10"),
        )
        with pytest.raises(Validation) as exc:
            service.settle_rebate(
                seeded_db, record.id, gross_amount=Decimal("100"), settled_on=TODAY,
                pool_id=invest.id, actor="pytest", platform_fee=Decimal("150"),
            )
        assert "手续费不得大于到账金额" in str(exc.value)

    def test_list_rebates_filters_by_source_order(self, seeded_db):
        first = _active_order(seeded_db)
        second = _active_order(seeded_db)
        service.create_rebate(
            seeded_db, source_order_id=first, base_amount=Decimal("100"),
            collected_on=TODAY, actor="pytest",
        )
        service.create_rebate(
            seeded_db, source_order_id=second, base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest",
        )
        by_order = service.list_rebates(seeded_db, source_order_id=second)
        assert [item.base_amount for item in by_order] == [Decimal("200.00")]
        assert len(service.list_rebates(seeded_db)) == 2


class TestFinanceApi:
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
            "/api/v1/transfers",
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
            "/api/v1/deposits", params={"pool_id": 2}, headers=scoped_headers
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

        service.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
        )
        service.create_deposit(
            seeded_db, pool_id=2, amount=Decimal("20"), paid_on=TODAY, actor="pytest"
        )
        own_order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="scoped-finance", owner_id=9
        )
        other_order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )
        service.create_rebate(
            seeded_db, source_order_id=own_order.id, base_amount=Decimal("10"),
            collected_on=TODAY, actor="pytest"
        )
        service.create_rebate(
            seeded_db, source_order_id=other_order.id, base_amount=Decimal("20"),
            collected_on=TODAY, actor="pytest"
        )

        deposits = seeded_client.get("/api/v1/deposits", headers=scoped_headers)
        assert deposits.status_code == 200, deposits.text
        assert {row["pool_id"] for row in deposits.json()} == {1}

        rebates = seeded_client.get("/api/v1/rebates", headers=scoped_headers)
        assert rebates.status_code == 200, rebates.text
        assert [row["source_order_id"] for row in rebates.json()] == [own_order.id]

        create_other_pool = seeded_client.post(
            "/api/v1/deposits",
            json={"pool_id": 2, "amount": "5", "paid_on": TODAY.isoformat()},
            headers=scoped_headers,
        )
        assert create_other_pool.status_code == 404

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
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("1"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-PAGE-2", pool_id=2, occurred_on=date(2026, 10, 2),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("2"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-PAGE-3", pool_id=1, occurred_on=date(2026, 10, 3),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("3"),
                    created_by="pytest", updated_by="pytest",
                ),
            ]
        )
        seeded_db.flush()

        response = seeded_client.get(
            "/api/v1/cashflows",
            params={"limit": 2, "offset": 2},
            headers=scoped_headers,
        )
        assert response.status_code == 200, response.text
        assert [row["flow_no"] for row in response.json()] == ["CF-PAGE-1"]

    def test_scoped_operator_cannot_write_rebate_for_other_order(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        other_order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )

        response = seeded_client.post(
            "/api/v1/rebates",
            json={
                "source_order_id": other_order.id,
                "base_amount": "10",
                "collected_on": TODAY.isoformat(),
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
        foreign_order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )
        with pytest.raises(NotFound):
            service.create_rebate(
                seeded_db,
                source_order_id=foreign_order.id,
                base_amount=Decimal("10"),
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
        foreign_order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
        )

        response = seeded_client.post(
            "/api/v1/deposits",
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

        response = seeded_client.post(
            "/api/v1/transfers",
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
        assert len(payload["cashflows"]) == 2
        assert {row["nature"] for row in payload["cashflows"]} == {"INTERNAL"}
        assert {row["direction"] for row in payload["cashflows"]} == {"IN", "OUT"}
        assert len({row["transfer_id"] for row in payload["cashflows"]}) == 1
        source_balance = orders_service.pool_balance(seeded_db, invest.id)
        target_balance = orders_service.pool_balance(seeded_db, profit.id)
        assert source_balance["cash_balance"] == Decimal("-125.50")
        assert target_balance["cash_balance"] == Decimal("125.50")
        assert source_balance["cash_balance"] + target_balance["cash_balance"] == Decimal("0.00")

    def test_list_cashflows_exposes_order_traceability(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db, source_order_id=order_id, base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest",
        )
        service.settle_rebate(
            seeded_db, record.id, gross_amount=Decimal("120"), settled_on=TODAY,
            pool_id=invest.id, actor="pytest", platform_fee=Decimal("20"),
        )
        deposit = service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("80"), paid_on=TODAY,
            actor="pytest", source_order_id=order_id,
        )
        service.return_deposit(
            seeded_db, deposit.id, amount=Decimal("30"), released_on=TODAY, actor="pytest"
        )

        response = seeded_client.get("/api/v1/cashflows", headers=headers)

        assert response.status_code == 200, response.text
        rows = response.json()
        assert {row["category"] for row in rows} >= {"BUY", "REBATE", "DEPOSIT_HOLD"}
        assert all("order_no" in row for row in rows)
        assert all(row["order_no"] is not None for row in rows)
        assert {row["source"] for row in rows} >= {"ORDER_EVENT", "REBATE_SETTLEMENT", "DEPOSIT"}
        deposit_rows = [row for row in rows if row["source"] == "DEPOSIT"]
        assert {row["deposit_id"] for row in deposit_rows} == {deposit.id}

    def test_list_deposits_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        response = seeded_client.get("/api/v1/deposits", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1
        assert "deposit_no" not in response.json()[0]

    def test_list_rebates_endpoint(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        service.create_rebate(
            seeded_db, source_order_id=order_id, base_amount=Decimal("100"),
            collected_on=TODAY, actor="pytest",
        )
        response = seeded_client.get("/api/v1/rebates", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1
        assert response.json()[0]["rebate_no"].startswith("HS")
        assert "rebate_group_no" not in response.json()[0]

    def test_create_rebate_endpoint(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        response = seeded_client.post(
            "/api/v1/rebates",
            json={
                "source_order_id": order_id,
                "base_amount": "300",
                "collected_on": TODAY.isoformat(),
                "rate": "5",
                "channel": "WECHAT",
            },
            headers=headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["source_order_id"] == order_id

    def test_settle_rebate_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db, source_order_id=order_id, base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest",
        )
        response = seeded_client.post(
            f"/api/v1/rebates/{record.id}/settlements",
            json={
                "gross_amount": "120",
                "settled_on": TODAY.isoformat(),
                "pool_id": invest.id,
                "platform_fee": "20",
            },
            headers=headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["net_amount"] == "100.00"
