"""accounts 账号台账契约测试（ACC-01）。

与 test_m2.py 的分工：既有文件已覆盖建账号与账号状态随订单事件流转；
本文件补空标识/重复建档校验、查询 404 与状态过滤、库存成本汇总
（只统计在库与分期中），以及带状态过滤的列表端点。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import AccountStatus, AuditAction
from app.domain.foundation import AuditLog, Pool
from app.domain.trade import Account
from app.accounts import service
from app.finance import service as finance_service
from app.orders import service as orders_service
from app.parties import service as parties_service

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
    def test_risk_level_is_not_part_of_account_domain(self, seeded_db):
        account = _account(seeded_db, "no-risk-field")
        assert not hasattr(account, "risk_level")

    def test_sold_account_profile_remains_editable(self, seeded_db):
        account = _account(seeded_db, "sold-editable")
        order = _buy(seeded_db, account, amount="500")
        orders_service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("800"),
            occurred_on=TODAY, actor="pytest",
        )

        updated = service.update_account_profile(
            seeded_db, account.id, actor="pytest", note="售出后补充说明"
        )

        assert updated.note == "售出后补充说明"

    def test_explicit_null_clears_optional_profile_fields(self, seeded_db):
        account = _account(
            seeded_db,
            "clearable-profile",
            account_description="旧说明",
            account_images=["data:image/png;base64,old"],
            note="旧备注",
        )

        updated = service.update_account_profile(
            seeded_db,
            account.id,
            actor="pytest",
            account_description=None,
            account_images=[],
            note=None,
        )

        assert updated.account_description is None
        assert updated.account_images == []
        assert updated.note is None

    def test_account_profile_update_is_recorded_as_account_audit(self, seeded_db):
        account = _account(seeded_db, "audited-account")
        service.update_account_profile(
            seeded_db,
            account.id,
            actor="pytest",
            account_description="已补充账号说明",
        )

        actions = list(
            seeded_db.scalars(
                select(AuditLog.action)
                .where(AuditLog.entity_id == account.inventory_no)
                .order_by(AuditLog.id)
            )
        )
        assert actions[-1] == AuditAction.ACCOUNT_UPDATE.value

    def test_account_creation_is_recorded_as_account_audit(self, seeded_db):
        account = _account(seeded_db, "created-audited-account", game_type="王者荣耀")

        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "account",
                AuditLog.entity_id == account.inventory_no,
                AuditLog.action == AuditAction.ACCOUNT_CREATE.value,
            )
        )

        assert audit is not None
        assert audit.actor == "pytest"
        assert audit.after_json["inventory_no"] == account.inventory_no
        assert audit.after_json["game_type"] == "王者荣耀"

    def test_empty_identifier_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_account(seeded_db, game_account="  ", actor="pytest")
        assert "账号标识必填" in str(exc.value)

    def test_duplicate_identifier_conflicts(self, seeded_db):
        _account(seeded_db, "dup-acc")
        with pytest.raises(Conflict) as exc:
            service.create_account(seeded_db, game_account="dup-acc", actor="pytest")
        assert "已在台账中" in str(exc.value)

    def test_consignments_enter_inventory_without_purchase_payment(self, seeded_db):
        account = _account(seeded_db, "consignment-acc", inventory_type="CONSIGNMENT")
        assert account.status == AccountStatus.IN_STOCK.value


class TestAccountQueries:
    def test_get_account_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.get_account(seeded_db, 999999)

    def test_get_account_returns_entity(self, seeded_db):
        account = _account(seeded_db, "get-acc")
        assert service.get_account(seeded_db, account.id).id == account.id

    def test_list_accounts_filters_by_status(self, seeded_db):
        first = _account(seeded_db, "first-acc")
        second = _account(seeded_db, "second-acc")

        assert [
            item.id for item in service.list_accounts(seeded_db)
        ] == [first.id, second.id]
        assert [
            item.id
            for item in service.list_accounts(
                seeded_db, status=AccountStatus.IN_STOCK.value
            )
        ] == [first.id, second.id]
        assert service.list_accounts(seeded_db, status="VOID") == []

    def test_inventory_and_total_cost_count_only_occupied(self, seeded_db):
        stocked = _account(seeded_db, "stock-acc")
        _buy(seeded_db, stocked, amount="500")

        inventory = service.inventory(seeded_db)
        assert [row["account_id"] for row in inventory] == [stocked.id]
        assert inventory[0]["cost_amount"] == Decimal("500.00")
        # total_inventory_cost 复用同一库存口径
        assert service.total_inventory_cost(seeded_db) == Decimal("500.00")


class TestAccountsApi:
    def test_account_endpoints_follow_order_owner_scope(
        self, seeded_client, seeded_db
    ):
        mine = _account(seeded_db, "scoped-mine")
        mine_order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="operator",
            account_id=mine.id,
            owner_id=9,
        )
        orders_service.post_event(
            seeded_db, mine_order.id, event_type="BUY", amount="300",
            occurred_on=TODAY, actor="operator",
        )

        other = _account(seeded_db, "scoped-other")
        other_order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            account_id=other.id,
            owner_id=8,
        )
        orders_service.post_event(
            seeded_db, other_order.id, event_type="BUY", amount="400",
            occurred_on=TODAY, actor="other",
        )

        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        listed = seeded_client.get("/api/v1/accounts", headers=headers)
        assert listed.status_code == 200, listed.text
        assert [row["inventory_no"] for row in listed.json()] == [mine.inventory_no]
        assert all("risk_level" not in row for row in listed.json())

        hidden_detail = seeded_client.get(
            f"/api/v1/accounts/{other.id}/execution-detail", headers=headers
        )
        assert hidden_detail.status_code == 404

        hidden_update = seeded_client.patch(
            f"/api/v1/accounts/{other.id}",
            json={"note": "不应修改"},
            headers=headers,
        )
        assert hidden_update.status_code == 404

        inventory = seeded_client.get("/api/v1/accounts/inventory", headers=headers)
        assert inventory.status_code == 200, inventory.text
        assert [row["account_id"] for row in inventory.json()["items"]] == [mine.id]

    def test_visible_account_does_not_leak_foreign_source_order(
        self, seeded_client, seeded_db
    ):
        account = service.create_account(
            seeded_db,
            game_account="scope-source-account",
            platform="王者",
            actor="operator",
        )
        foreign_order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            account_id=account.id,
            owner_id=8,
        )
        orders_service.post_event(
            seeded_db,
            foreign_order.id,
            event_type="BUY",
            amount="300",
            occurred_on=TODAY,
            actor="other",
        )

        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        response = seeded_client.get(
            f"/api/v1/accounts/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["account"]["source_order_no"] is None
        assert response.json()["orders"] == []

    def test_standalone_account_creation_endpoint_removed(self, seeded_client, headers):
        response = seeded_client.post(
            "/api/v1/accounts",
            json={
                "game_account": "standalone-account",
                "business_mode": "SELF",
                "inventory_type": "RECOVERY",
            },
            headers=headers,
        )
        assert response.status_code == 405, response.text

    def test_order_creation_provides_standard_inventory_context(
        self, seeded_client, seeded_db, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account": {"game_account": "standard-context", "platform": "王者"},
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        account = seeded_db.get(Account, created.json()["account_id"])
        assert account is not None
        assert account.business_mode == "SELF"
        assert account.inventory_type == "RECOVERY"

    def test_create_account_persists_description_and_at_most_nine_images(
        self, seeded_client, seeded_db, headers
    ):
        images = [f"data:image/png;base64,image-{index}" for index in range(9)]
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account": {
                    "game_account": "account-with-media",
                    "platform": "王者",
                    "account_description": "高段位，未绑定二次验证",
                    "account_images": images,
                },
            },
            headers=headers,
        )

        assert created.status_code == 201, created.text
        account_id = created.json()["account_id"]
        account = seeded_db.get(Account, account_id)
        assert account is not None
        assert account.account_description == "高段位，未绑定二次验证"
        assert account.account_images == images

        updated_images = [f"data:image/jpeg;base64,updated-{index}" for index in range(9)]
        updated = seeded_client.patch(
            f"/api/v1/accounts/{account_id}",
            json={
                "account_description": "已补充平台与资源说明",
                "game_type": "王者荣耀",
                "game_account": "account-with-media-renamed",
                "game_password": "new-secret",
                "channel_region": "安卓一区",
                "bound_phone": "13800000000",
                "has_secondary": True,
                "platform": "王者平台",
                "note": "资料已核验",
                "account_images": updated_images,
            },
            headers=headers,
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["account_description"] == "已补充平台与资源说明"
        assert updated.json()["account_images"] == updated_images
        assert updated.json()["game_account"] == "account-with-media-renamed"
        assert updated.json()["game_password"] == "new-secret"
        assert updated.json()["has_secondary"] is True

        cleared = seeded_client.patch(
            f"/api/v1/accounts/{account_id}",
            json={"account_description": None, "account_images": [], "note": None},
            headers=headers,
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["account_description"] is None
        assert cleared.json()["account_images"] == []
        assert cleared.json()["note"] is None

    def test_list_accounts_endpoint_with_status(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "api-acc")
        _buy(seeded_db, account, amount="300")
        response = seeded_client.get(
            "/api/v1/accounts", params={"status": "VOID"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json() == []

        stocked = seeded_client.get(
            "/api/v1/accounts", params={"status": AccountStatus.IN_STOCK.value},
            headers=headers,
        )
        assert [item["inventory_no"] for item in stocked.json()] == [account.inventory_no]

    def test_list_accounts_resolves_each_source_order(self, seeded_client, seeded_db, headers):
        first = _account(seeded_db, "batch-source-first")
        second = _account(seeded_db, "batch-source-second")
        first_order = _buy(seeded_db, first, amount="300")
        second_order = _buy(seeded_db, second, amount="400")

        response = seeded_client.get("/api/v1/accounts", headers=headers)

        assert response.status_code == 200, response.text
        source_orders = {
            item["inventory_no"]: item["source_order_no"] for item in response.json()
        }
        assert source_orders[first.inventory_no] == first_order.order_no
        assert source_orders[second.inventory_no] == second_order.order_no

    def test_list_accounts_does_not_use_unposted_order_as_source(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "unposted-source")
        orders_service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )

        response = seeded_client.get("/api/v1/accounts", headers=headers)

        assert response.status_code == 200, response.text
        item = next(row for row in response.json() if row["inventory_no"] == account.inventory_no)
        assert item["source_order_no"] is None

    def test_execution_detail_includes_source_order(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-acc")
        order = _buy(seeded_db, account, amount="300")

        response = seeded_client.get(
            f"/api/v1/accounts/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["account"]["source_order_no"] == order.order_no

    def test_execution_detail_includes_minute_timestamps(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-time-acc")
        order = _buy(seeded_db, account, amount="300")

        response = seeded_client.get(
            f"/api/v1/accounts/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        order_payload = response.json()["orders"][0]
        event_payload = order_payload["events"][0]
        assert order_payload["order_no"] == order.order_no
        assert datetime.fromisoformat(order_payload["created_at"])
        assert datetime.fromisoformat(event_payload["occurred_at"])

    def test_execution_detail_includes_consign_platform(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-platform-acc")
        platform = parties_service.create_counterparty(
            seeded_db, display_name="寄售平台A", type="PLATFORM", actor="pytest"
        )
        order = orders_service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            counterparty_roles=[(platform.id, "PLATFORM")],
        )

        response = seeded_client.get(
            f"/api/v1/accounts/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["order_no"] == order.order_no
        assert response.json()["orders"][0]["counterparties"] == [
            {"id": platform.id, "display_name": "寄售平台A", "role": "PLATFORM"}
        ]

    def test_execution_detail_includes_rebate_amount(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-rebate-acc")
        order = _buy(seeded_db, account, amount="300")
        rebate = finance_service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            base_amount=Decimal("300"),
            rate=Decimal("5"),
            collected_on=TODAY,
            channel="买号返点",
            actor="pytest",
        )

        response = seeded_client.get(
            f"/api/v1/accounts/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["rebates"] == [{
            "id": rebate.id,
            "rebate_no": rebate.rebate_no,
            "channel": "买号返点",
            "rate": "5.00",
            "base_amount": "300.00",
            "status": "OPEN",
            "collected_on": TODAY.isoformat(),
            "collected_at": rebate.created_at.isoformat(),
        }]

    def test_execution_detail_ignores_independent_dfq_order(
        self, seeded_client, seeded_db, headers
    ):
        account = _account(seeded_db, "source-priority-acc")
        source_order = _buy(seeded_db, account, amount="300")
        orders_service.create_order(
            seeded_db, order_type="DFQ", trade_date=TODAY, actor="pytest"
        )

        response = seeded_client.get(
            f"/api/v1/accounts/{account.id}/execution-detail", headers=headers
        )

        assert response.json()["account"]["source_order_no"] == source_order.order_no
