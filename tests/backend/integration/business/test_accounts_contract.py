"""API-01 accounts 账号台账契约测试。

与 test_m2.py 的分工：既有文件已覆盖建账号与账号状态随订单事件流转；
本文件补空标识/重复建档校验、查询 404 与状态过滤、库存成本汇总
（只统计在库与分期中），以及带状态过滤的列表端点。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import AccountStatus, AuditAction
from app.domain.foundation import AuditLog, Pool
from app.domain.trade import Account
from app.stocks import service
from app.finance import service as finance_service
from app.orders import service as orders_service
from app.parties import service as parties_service

TODAY = date(2026, 10, 4)

def _account(seeded_db, game_account: str, **kwargs):
    inventory_type = kwargs.get("inventory_type", "RECOVERY")
    kwargs.setdefault(
        "business_mode",
        "DISTRIBUTION" if inventory_type in {"PICKUP", "CONSIGNMENT"} else "SELF",
    )
    kwargs.setdefault("inventory_type", inventory_type)
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

def test_account_list_supports_limit_and_offset(seeded_client, seeded_db):
    _account(seeded_db, "page-account-1")
    _account(seeded_db, "page-account-2")
    _account(seeded_db, "page-account-3")

    response = seeded_client.get(
        "/api/v1/stocks", headers={"X-Dev-User": "admin"},
        params={"limit": 1, "offset": 1},
    )

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 3
    assert response.json()["limit"] == 1
    assert response.json()["offset"] == 1
    assert len(response.json()["items"]) == 1
    assert response.json()["items"][0]["game_account"] == "page-account-2"

class TestCreateAccountGuards:
    def test_account_records_inventory_entry_time_to_second(self, seeded_db, seeded_client):
        account = _account(seeded_db, "inventory-entry-time")
        seeded_db.flush()

        assert account.inventory_entry_at is not None
        assert account.inventory_entry_at.microsecond == 0
        listed = seeded_client.get("/api/v1/stocks", headers={"X-Dev-User": "admin"})
        assert listed.status_code == 200, listed.text
        item = next(row for row in listed.json()["items"] if row["id"] == account.id)
        assert item["inventory_entry_at"] is not None

    def test_pickup_inventory_type_can_be_created_for_th(self, seeded_db):
        account = service.create_account(
            seeded_db,
            game_account="pickup-inventory-entity",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            actor="pytest",
        )
        assert account.inventory_type == "PICKUP"

    def test_unknown_business_mode_is_rejected(self, seeded_db):
        with pytest.raises(Validation, match="业务模式无效"):
            _account(
                seeded_db,
                "invalid-business-mode",
                business_mode="UNKNOWN",
            )

    def test_unknown_inventory_type_is_rejected(self, seeded_db):
        with pytest.raises(Validation, match="业务类型无效"):
            _account(
                seeded_db,
                "invalid-inventory-type",
                inventory_type="UNKNOWN",
            )

    def test_business_mode_and_inventory_type_must_match(self, seeded_db):
        with pytest.raises(Validation, match="业务模式与业务类型不匹配"):
            _account(
                seeded_db,
                "invalid-inventory-context",
                business_mode="SELF",
                inventory_type="CONSIGNMENT",
            )

    def test_description_and_images_only_belong_to_recovery_or_consignment(
        self, seeded_db
    ):
        consignment = _account(
            seeded_db,
            "consignment-profile",
            business_mode="DISTRIBUTION",
            inventory_type="CONSIGNMENT",
            account_description="代挂账号描述",
            account_images=["image-1"],
        )
        assert consignment.account_description == "代挂账号描述"

    def test_database_rejects_invalid_inventory_context(self, seeded_db):
        account = Account(
            game_account="db-invalid-context",
            business_mode="SELF",
            inventory_type="CONSIGNMENT",
            status=AccountStatus.WAITING.value,
        )
        seeded_db.add(account)
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_account_creation_rejects_more_than_nine_images(self, seeded_db):
        with pytest.raises(Validation, match="最多 9 张"):
            _account(
                seeded_db,
                "too-many-images",
                account_images=[f"image-{index}" for index in range(10)],
            )

    def test_account_update_rejects_more_than_nine_images(self, seeded_db):
        account = _account(seeded_db, "too-many-update-images")
        with pytest.raises(Validation, match="最多 9 张"):
            service.update_account_profile(
                seeded_db,
                account.id,
                actor="pytest",
                account_images=[f"image-{index}" for index in range(10)],
            )

    def test_account_update_validates_profile_scope_before_mutating_identifier(self, seeded_db):
        account = Account(
            game_account="pickup-original",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            status=AccountStatus.WAITING.value,
            cost_amount=Decimal("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation, match="仅适用于回收或代挂"):
            service.update_account_profile(
                seeded_db,
                account.id,
                actor="operator",
                game_account="pickup-should-not-change",
                account_description="不允许的描述",
            )

        seeded_db.commit()
        seeded_db.refresh(account)
        assert account.game_account == "pickup-original"
        assert account.updated_by == "pytest"

    def test_account_images_must_be_an_array(self, seeded_db):
        with pytest.raises(Validation, match="必须为数组"):
            _account(seeded_db, "invalid-image-shape", account_images="image-url")

    def test_has_secondary_must_be_boolean_in_service(self, seeded_db):
        with pytest.raises(Validation, match="has_secondary 必须为布尔值"):
            _account(seeded_db, "invalid-secondary-shape", has_secondary="false")

        account = _account(seeded_db, "invalid-secondary-update")
        with pytest.raises(Validation, match="has_secondary 必须为布尔值"):
            service.update_account_profile(
                seeded_db, account.id, actor="pytest", has_secondary="false"
            )
        seeded_db.commit()
        seeded_db.refresh(account)
        assert account.has_secondary is None

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
                .where(AuditLog.entity_id == str(account.id))
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
                AuditLog.entity_id == str(account.id),
                AuditLog.action == AuditAction.ACCOUNT_CREATE.value,
            )
        )

        assert audit is not None
        assert audit.actor == "pytest"
        assert audit.after_json["game_type"] == "王者荣耀"

    def test_empty_identifier_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_account(seeded_db, game_account="  ", actor="pytest")
        assert "库存编号必填" in str(exc.value)

    def test_identifier_must_be_text_in_service(self, seeded_db):
        with pytest.raises(Validation, match="库存编号必填"):
            service.create_account(seeded_db, game_account=123, actor="pytest")

        account = _account(seeded_db, "update-identifier-type")
        with pytest.raises(Validation, match="库存编号必填"):
            service.update_account_profile(
                seeded_db, account.id, actor="pytest", game_account=123
            )

    def test_duplicate_identifier_allowed_as_repeat_purchase(self, seeded_db):
        """game_account 不唯一，复购同号各建独立实体。"""
        first = _account(seeded_db, "dup-acc")
        second = service.create_account(seeded_db, game_account="dup-acc", actor="pytest")
        assert second.id != first.id
        assert second.stock_no != first.stock_no
        assert second.game_account == first.game_account == "dup-acc"

    def test_consignments_enter_inventory_without_purchase_payment(self, seeded_db):
        account = _account(seeded_db, "consignment-acc", inventory_type="CONSIGNMENT")
        assert account.status == AccountStatus.WAITING.value

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
                seeded_db, status=AccountStatus.WAITING.value
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

    def test_inventory_rejects_removed_for_sale_status(self, seeded_db):
        account = _account(seeded_db, "removed-for-sale-acc")
        account.status = "FOR_SALE"

        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_pickup_accounts_are_inventory_assets(self, seeded_db):
        pickup = Account(
            game_account="pickup-not-inventory",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            status=AccountStatus.WAITING.value,
            cost_amount=Decimal("300.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(pickup)
        seeded_db.flush()

        assert pickup in service.list_accounts(seeded_db)
        assert pickup.id in {row["account_id"] for row in service.inventory(seeded_db)}
        assert service.total_inventory_cost(seeded_db) == Decimal("300.00")

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

        listed = seeded_client.get("/api/v1/stocks", headers=headers)
        assert listed.status_code == 200, listed.text
        assert [row["game_account"] for row in listed.json()["items"]] == [mine.game_account]
        assert all("risk_level" not in row for row in listed.json()["items"])

        hidden_detail = seeded_client.get(
            f"/api/v1/stocks/{other.id}/execution-detail", headers=headers
        )
        assert hidden_detail.status_code == 404

        batch_detail = seeded_client.get(
            f"/api/v1/stocks/execution-details?ids={mine.id},{other.id}", headers=headers
        )
        assert batch_detail.status_code == 200, batch_detail.text
        assert str(mine.id) in batch_detail.json()
        assert str(other.id) not in batch_detail.json()

        hidden_update = seeded_client.patch(
            f"/api/v1/stocks/{other.id}",
            json={"note": "不应修改"},
            headers=headers,
        )
        assert hidden_update.status_code == 404

        inventory = seeded_client.get("/api/v1/stocks/inventory", headers=headers)
        assert inventory.status_code == 200, inventory.text
        assert [row["account_id"] for row in inventory.json()["items"]] == [mine.id]

    def test_visible_account_does_not_leak_foreign_source_order(
        self, seeded_client, seeded_db
    ):
        account = service.create_account(
            seeded_db,
            game_account="scope-source-account",
            platform="王者",
            business_mode="SELF",
            inventory_type="RECOVERY",
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
            f"/api/v1/stocks/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["account"]["source_order_no"] is None
        assert response.json()["orders"] == []

    def test_read_only_finance_user_cannot_read_game_password(
        self, seeded_client, seeded_db
    ):
        account = _account(seeded_db, "credential-scope-account", game_password="secret")
        viewer = CurrentUser.build(
            id=9, username="finance-reader", roles=["VIEWER"], owner_scope="ALL"
        )
        viewer_headers = {"Authorization": f"Bearer {build_access_token(viewer)}"}

        listed = seeded_client.get("/api/v1/stocks", headers=viewer_headers)
        assert listed.status_code == 200, listed.text
        item = next(row for row in listed.json()["items"] if row["id"] == account.id)
        assert item["game_password"] is None

        detail = seeded_client.get(
            f"/api/v1/stocks/{account.id}/execution-detail",
            headers=viewer_headers,
        )
        assert detail.status_code == 200, detail.text
        assert detail.json()["account"]["game_password"] is None

    def test_list_accounts_endpoint_with_status(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "api-acc")
        _buy(seeded_db, account, amount="300")
        response = seeded_client.get(
            "/api/v1/stocks", params={"status": "VOID"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["items"] == []

        stocked = seeded_client.get(
            "/api/v1/stocks", params={"status": AccountStatus.WAITING.value},
            headers=headers,
        )
        assert [item["game_account"] for item in stocked.json()["items"]] == [account.game_account]

    def test_list_accounts_resolves_each_source_order(self, seeded_client, seeded_db, headers):
        first = _account(seeded_db, "batch-source-first")
        second = _account(seeded_db, "batch-source-second")
        first_order = _buy(seeded_db, first, amount="300")
        second_order = _buy(seeded_db, second, amount="400")

        response = seeded_client.get("/api/v1/stocks", headers=headers)

        assert response.status_code == 200, response.text
        source_orders = {
            item["game_account"]: item["source_order_no"] for item in response.json()["items"]
        }
        assert source_orders[first.game_account] == first_order.order_no
        assert source_orders[second.game_account] == second_order.order_no

    def test_list_accounts_uses_consignment_order_without_buy(self, seeded_client, seeded_db, headers):
        account = _account(
            seeded_db,
            "unposted-source",
            business_mode="DISTRIBUTION",
            inventory_type="CONSIGNMENT",
        )
        order = orders_service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )

        response = seeded_client.get("/api/v1/stocks", headers=headers)

        assert response.status_code == 200, response.text
        item = next(row for row in response.json()["items"] if row["game_account"] == account.game_account)
        assert item["source_order_no"] == order.order_no

    def test_list_accounts_keeps_cancelled_source_order_number(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "cancelled-source")
        order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        orders_service.cancel_order(seeded_db, order.id, actor="pytest", reason="测试取消")

        response = seeded_client.get("/api/v1/stocks", headers=headers)

        assert response.status_code == 200, response.text
        item = next(row for row in response.json()["items"] if row["game_account"] == account.game_account)
        assert item["source_order_no"] == order.order_no

    def test_list_accounts_resolves_th_source_order(self, seeded_client, seeded_db, headers):
        account = _account(
            seeded_db,
            "th-source-account",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
        )
        order = orders_service.create_order(
            seeded_db,
            order_type="TH",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        orders_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100.00"),
            occurred_on=TODAY,
            actor="pytest",
        )

        response = seeded_client.get("/api/v1/stocks", headers=headers)

        assert response.status_code == 200, response.text
        item = next(row for row in response.json()["items"] if row["game_account"] == account.game_account)
        assert item["source_order_no"] == order.order_no

    def test_execution_detail_includes_source_order(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-acc")
        order = _buy(seeded_db, account, amount="300")

        response = seeded_client.get(
            f"/api/v1/stocks/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["account"]["source_order_no"] == order.order_no

    def test_execution_detail_includes_order_linked_standalone_cashflows(
        self, seeded_client, seeded_db, headers
    ):
        account = _account(seeded_db, "detail-standalone-flow-acc")
        order = _buy(seeded_db, account, amount="300")
        pool = _invest_pool(seeded_db)
        flow = finance_service.create_cashflow(
            seeded_db,
            pool_id=pool.id,
            occurred_on=TODAY,
            direction="OUT",
            category="OTHER",
            amount=Decimal("12"),
            order_id=order.id,
            note="订单关联的独立支出",
            actor="pytest",
        )

        response = seeded_client.get(
            f"/api/v1/stocks/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        order_payload = next(
            item for item in response.json()["orders"] if item["order_id"] == order.id
        )
        assert order_payload["cashflows"] == [
            {
                "flow_no": flow.flow_no,
                "pool_name": pool.name,
                "occurred_on": TODAY.isoformat(),
                "occurred_at": order_payload["cashflows"][0]["occurred_at"],
                "direction": "OUT",
                "category": "OTHER",
                "amount": "12.00",
                "note": "订单关联的独立支出",
                "operator": "pytest",
            }
        ]

    def test_execution_detail_includes_minute_timestamps(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-time-acc")
        order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        event, _ = orders_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("300"),
            occurred_on=TODAY,
            actor="pytest",
            reason="核验回收成本",
            note="带理由的买入动作",
        )

        response = seeded_client.get(
            f"/api/v1/stocks/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        order_payload = response.json()["orders"][0]
        event_payload = order_payload["events"][0]
        assert order_payload["order_no"] == order.order_no
        assert datetime.fromisoformat(order_payload["created_at"])
        assert datetime.fromisoformat(event_payload["occurred_at"])
        assert datetime.fromisoformat(event_payload["created_at"])
        assert datetime.fromisoformat(event_payload["posted_at"])
        assert event_payload["reason"] == "核验回收成本"
        assert event_payload["offset_event_id"] is None
        assert event_payload["id"] == event.id

    def test_execution_detail_includes_consign_platform(self, seeded_client, seeded_db, headers):
        account = _account(
            seeded_db,
            "detail-platform-acc",
            business_mode="DISTRIBUTION",
            inventory_type="CONSIGNMENT",
        )
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
            f"/api/v1/stocks/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["order_no"] == order.order_no
        assert response.json()["orders"][0]["counterparties"] == [
            {"id": platform.id, "display_name": "寄售平台A", "role": "PLATFORM"}
        ]

    def test_execution_detail_includes_customer_participants(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-customer-party-acc")
        customer = parties_service.create_customer(seeded_db, display_name="买家A", actor="pytest")
        seller = parties_service.create_customer(seeded_db, display_name="卖家B", actor="pytest")
        orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            customer_roles=[(customer.id, "BUYER"), (seller.id, "SELLER")],
        )

        response = seeded_client.get(
            f"/api/v1/stocks/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["customers"] == [
            {"id": customer.id, "display_name": "买家A", "role": "BUYER"},
            {"id": seller.id, "display_name": "卖家B", "role": "SELLER"},
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
            rebate_type="BUY",
            channel="买号返点",
            actor="pytest",
        )
        response = seeded_client.get(
            f"/api/v1/stocks/{account.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["rebates"] == [{
            "id": rebate.id,
            "rebate_no": rebate.rebate_no,
            "rebate_type": "BUY",
            "channel": "买号返点",
            "rate": "5.00",
            "base_amount": "300.00",
            "status": "SETTLED",
            "collected_on": TODAY.isoformat(),
            "collected_at": rebate.created_at.isoformat(),
        }]

