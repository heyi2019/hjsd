"""accounts 账号台账契约测试（ACC-01）。

与 test_m2.py 的分工：既有文件已覆盖建账号与账号状态随订单事件流转；
本文件补空标识/重复建档校验、查询 404 与状态过滤、库存成本汇总
（只统计在库与分期中），以及带状态过滤的列表端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.domain.enums import AccountStatus
from app.domain.foundation import Pool
from app.accounts import service
from app.orders import service as orders_service

TODAY = date(2026, 10, 4)


def _account(seeded_db, game_account: str, **kwargs):
    return service.create_account(
        seeded_db, game_account=game_account, platform="王者", actor="pytest", **kwargs
    )


def _invest_pool(seeded_db) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    return pool


def _buy(seeded_db, account, amount="500"):
    order = orders_service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id,
    )
    orders_service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal(amount),
        occurred_on=TODAY, actor="pytest",
    )
    return order


class TestCreateAccountGuards:
    def test_empty_identifier_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_account(seeded_db, game_account="  ", actor="pytest")
        assert "账号标识必填" in str(exc.value)

    def test_duplicate_identifier_conflicts(self, seeded_db):
        _account(seeded_db, "dup-acc")
        with pytest.raises(Conflict) as exc:
            service.create_account(seeded_db, game_account="dup-acc", actor="pytest")
        assert "已在台账中" in str(exc.value)


class TestAccountQueries:
    def test_get_account_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.get_account(seeded_db, 999999)

    def test_get_account_returns_entity(self, seeded_db):
        account = _account(seeded_db, "get-acc")
        assert service.get_account(seeded_db, account.id).id == account.id

    def test_list_accounts_filters_by_status(self, seeded_db):
        pending = _account(seeded_db, "pending-acc")
        bought = _account(seeded_db, "stock-acc")
        _buy(seeded_db, bought)

        assert [
            item.id for item in service.list_accounts(seeded_db)
        ] == [pending.id, bought.id]
        assert [
            item.id
            for item in service.list_accounts(
                seeded_db, status=AccountStatus.IN_STOCK.value
            )
        ] == [bought.id]
        assert service.list_accounts(seeded_db, status="VOID") == []

    def test_inventory_and_total_cost_count_only_occupied(self, seeded_db):
        stocked = _account(seeded_db, "stock-acc")
        _account(seeded_db, "pending-acc")  # PENDING：不计入库存占用
        _buy(seeded_db, stocked, amount="500")

        inventory = service.inventory(seeded_db)
        assert [row["account_id"] for row in inventory] == [stocked.id]
        assert inventory[0]["cost_amount"] == Decimal("500.00")
        # total_inventory_cost 复用同一库存口径
        assert service.total_inventory_cost(seeded_db) == Decimal("500.00")


class TestAccountsApi:
    def test_list_accounts_endpoint_with_status(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "api-acc")
        _buy(seeded_db, account, amount="300")
        response = seeded_client.get(
            "/api/v1/accounts", params={"status": AccountStatus.PENDING.value},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json() == []

        stocked = seeded_client.get(
            "/api/v1/accounts", params={"status": AccountStatus.IN_STOCK.value},
            headers=headers,
        )
        assert [item["account_no"] for item in stocked.json()] == [account.account_no]
