"""finance 押金与返点契约测试（DEP-01 / REB-01）。

与 test_m2.py / test_bughunt.py 的分工：既有文件已覆盖押金占用/部分退回、
超退校验、返点归集与结算主路径；本文件补押金退还 404、押金列表与持有合计、
来源订单不存在、结算 404 与手续费超额、返点列表过滤，以及 4 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.domain.foundation import Pool
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
    def test_list_deposits_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        response = seeded_client.get("/api/v1/deposits", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1

    def test_list_rebates_endpoint(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        service.create_rebate(
            seeded_db, source_order_id=order_id, base_amount=Decimal("100"),
            collected_on=TODAY, actor="pytest",
        )
        response = seeded_client.get("/api/v1/rebates", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1

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
