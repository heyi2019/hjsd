"""API-01 accounts 账号台账契约测试（ACC-01）。

与 test_installments_finance_integration.py 的分工：后者覆盖跨业务联动；
本文件补空标识/重复建档校验、查询 404 与状态过滤、库存成本汇总
（只统计在库与分期中），以及库存台账服务。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import IntegrityError

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import AccountStatus, AuditAction
from app.domain.foundation import AuditLog, Pool
from app.domain.trade import Account, Order
from app.domain.users import User
from app.business.inventory.inventory import inventory, inventory_ledger, list_accounts, total_inventory_cost
from app.business.inventory.profile import create_account, get_account, update_account_profile
from app.finance.cashflow.cashflows import create_cashflow
from app.finance.rebates import create_rebate
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.customers.counterparties import create_counterparty
from app.customers.customers import create_customer

TODAY = date(2026, 10, 4)

def _account(seeded_db, game_account: str, **kwargs):
    inventory_type = kwargs.get("inventory_type", "RECOVERY")
    kwargs.setdefault(
        "business_mode",
        "DISTRIBUTION" if inventory_type in {"PICKUP", "CONSIGNMENT"} else "SELF",
    )
    kwargs.setdefault("inventory_type", inventory_type)
    return create_account(
        seeded_db, game_account=game_account, actor="pytest", **kwargs
    )

def _invest_pool(seeded_db) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    return pool

def _buy(seeded_db, account, amount="500"):
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal(amount),
        occurred_on=TODAY, actor="pytest",
    )
    return order

class TestCreateAccountGuards:
    def test_execution_detail_can_return_compressed_previews_without_changing_originals(self, seeded_client, seeded_db, headers):
        import base64
        from io import BytesIO
        from PIL import Image

        image = Image.effect_noise((900, 900), 80).convert("RGB")
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        original = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
        account = _account(seeded_db, "execution-preview-images")
        account.account_images = [original]
        order = _buy(seeded_db, account)
        seeded_db.flush()

        preview = seeded_client.get(f"/api/orders/{order.id}/execution-detail", params={"image_previews": "true"}, headers=headers)
        assert preview.status_code == 200, preview.text
        data = preview.json()
        assert data["image_previews"] is True
        thumbnail = data["account"]["account_images"][0]
        assert len(thumbnail) < len(original) // 4
        with Image.open(BytesIO(base64.b64decode(thumbnail.split(",", 1)[1]))) as resized:
            assert max(resized.size) <= 320

        version = data["image_versions"]["account_images"][0]
        image_response = seeded_client.get(f"/api/orders/{order.id}/execution-images/account_images/0", params={"version": version}, headers=headers)
        assert image_response.status_code == 200
        assert image_response.json()["image"] == original
        assert seeded_client.get(f"/api/orders/{order.id}/execution-images/not_a_field/0", headers=headers).status_code == 422
        assert seeded_client.get(f"/api/orders/{order.id}/execution-images/account_images/0", params={"version": "outdated"}, headers=headers).status_code == 409

        full = seeded_client.get(f"/api/orders/{order.id}/execution-detail", headers=headers)
        assert full.json()["account"]["account_images"] == [original]
        seeded_db.refresh(account)
        assert account.account_images == [original]

    def test_inventory_light_page_omits_images_without_loading_them_and_detail_keeps_images(self, seeded_client, seeded_db, headers):
        from sqlalchemy import event

        account = _account(seeded_db, "light-inventory-images")
        account.secondary_images = ["data:image/png;base64,secondary"]
        account.wallet_realname_images = ["data:image/png;base64,wallet"]
        account.account_images = ["data:image/png;base64,profile"]
        order = _buy(seeded_db, account)
        account_id, order_id = account.id, order.id
        seeded_db.flush()
        seeded_db.expire_all()
        statements = []

        def record_sql(_conn, _cursor, statement, _parameters, _context, _many):
            statements.append(" ".join(statement.lower().split()))

        connection = seeded_db.connection()
        event.listen(connection, "before_cursor_execute", record_sql)
        try:
            response = seeded_client.get("/api/stocks/inventory/ledger", params={"include_images": "false"}, headers=headers)
        finally:
            event.remove(connection, "before_cursor_execute", record_sql)
        assert response.status_code == 200, response.text
        row = next(item["account"] for item in response.json()["items"] if item["account"]["id"] == account_id)
        assert row["secondary_images"] is None
        assert row["wallet_realname_images"] is None
        assert row["account_images"] is None
        assert not any("where stocks.id =" in sql and any(name in sql for name in ("secondary_images", "wallet_realname_images", "account_images")) for sql in statements)

        detail = seeded_client.get(f"/api/orders/{order_id}/execution-detail", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["account"]["secondary_images"] == ["data:image/png;base64,secondary"]
        assert detail.json()["account"]["wallet_realname_images"] == ["data:image/png;base64,wallet"]
        assert detail.json()["account"]["account_images"] == ["data:image/png;base64,profile"]
        normal = seeded_client.get("/api/stocks/inventory/ledger", headers=headers)
        assert next(item["account"] for item in normal.json()["items"] if item["account"]["id"] == account_id)["account_images"] == ["data:image/png;base64,profile"]

    def test_inventory_search_matches_cost_amount(self, seeded_db):
        account = _account(seeded_db, "amount-search-inventory")
        _buy(seeded_db, account, amount="5432.10")
        other = _account(seeded_db, "amount-search-other")
        _buy(seeded_db, other, amount="54321.00")
        result = inventory_ledger(seeded_db, keyword="5,432.10")
        assert result["total"] == 1
        assert result["items"][0][0].id == account.id
        account.cost_amount = Decimal("5500.00")
        seeded_db.flush()
        assert inventory_ledger(seeded_db, keyword="5432.10")["items"][0][0].id == account.id
        assert inventory_ledger(seeded_db, keyword="5500")["items"][0][0].id == account.id

    def test_inventory_ledger_reuses_visible_source_order(self, seeded_client, seeded_db, headers):
        from sqlalchemy import event

        account = _account(seeded_db, "source-order-reuse")
        order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id)
        seeded_db.flush()
        source_queries = []

        def record_sql(_conn, _cursor, statement, _params, _context, _many):
            sql = " ".join(statement.lower().split())
            if "from orders where orders.account_id in" in sql:
                source_queries.append(sql)

        engine = seeded_db.get_bind()
        event.listen(engine, "after_cursor_execute", record_sql)
        try:
            response = seeded_client.get("/api/stocks/inventory/ledger", headers=headers)
        finally:
            event.remove(engine, "after_cursor_execute", record_sql)

        assert response.status_code == 200, response.text
        row = next(item for item in response.json()["items"] if item["account"]["id"] == account.id)
        assert row["account"]["source_order_id"] == order.id
        assert row["account"]["source_order_no"] == order.order_no
        assert source_queries == []

        from app.business.inventory.router_output import _account_outputs
        admin = CurrentUser.build(id=1, username="admin", roles=["ADMIN"], owner_scope="ALL")
        normal = _account_outputs(seeded_db, [account], admin)[0]
        reused = _account_outputs(seeded_db, [account], admin, loaded_orders=[order])[0]
        assert reused.model_dump() == normal.model_dump()
        restricted = CurrentUser.build(id=999999, username="limited", roles=["VIEWER"], owner_scope="SELF")
        assert order.owner_id != restricted.id
        limited = _account_outputs(seeded_db, [account], restricted, loaded_orders=[order])[0]
        assert limited.source_order_id is None
        assert limited.source_order_no is None

        owner = seeded_db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).first()
        owner.team_ids = [42042]
        order.owner_id = owner.id
        seeded_db.flush()
        scoped_users = [
            CurrentUser.build(id=owner.id, username=owner.username, roles=["VIEWER"], owner_scope="SELF"),
            CurrentUser.build(id=999999, username="team", roles=["VIEWER"], owner_scope="TEAM", team_ids=frozenset({42042})),
            restricted,
            CurrentUser.build(id=999999, username="other-team", roles=["VIEWER"], owner_scope="TEAM", team_ids=frozenset({42043})),
        ]
        for scoped_user in scoped_users:
            expected = _account_outputs(seeded_db, [account], scoped_user)[0]
            source_queries.clear()
            event.listen(engine, "after_cursor_execute", record_sql)
            try:
                actual = _account_outputs(seeded_db, [account], scoped_user, loaded_orders=[order])[0]
            finally:
                event.remove(engine, "after_cursor_execute", record_sql)
            assert actual.model_dump() == expected.model_dump()
            assert source_queries == []

    def test_inventory_ledger_reuses_facet_counts_for_total(self, seeded_db):
        from sqlalchemy import event

        for name in ("facet-query-hit", "facet-query-other"):
            account = _account(seeded_db, name)
            create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id)
        unclassified = _account(seeded_db, "facet-query-unclassified")
        legacy_order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=unclassified.id)
        unclassified.inventory_type = None
        legacy_order.order_type = "OTHER"
        legacy_order.account_snapshot = None
        seeded_db.flush()
        statements = []

        def record_sql(_conn, _cursor, statement, _params, _context, _many):
            if statement.lstrip().lower().startswith("select"):
                statements.append(statement)

        connection = seeded_db.connection()
        event.listen(connection, "before_cursor_execute", record_sql)
        try:
            result = inventory_ledger(seeded_db, keyword="facet-query-hit")
        finally:
            event.remove(connection, "before_cursor_execute", record_sql)

        assert result["total"] == 1
        assert result["facet_total"] == 3
        assert result["type_counts"] == {"RECOVERY": 2}
        assert len(statements) == 5
        date_filtered = inventory_ledger(seeded_db, date_from=date.today() + timedelta(days=1))
        assert date_filtered["total"] == 0
        assert date_filtered["facet_total"] == 3
        assert date_filtered["type_counts"] == {"RECOVERY": 2}

        owner = seeded_db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).first()
        owner.team_ids = [42042]
        for order in seeded_db.scalars(select(Order)).all():
            order.owner_id = owner.id
        hidden_account = _account(seeded_db, "facet-query-hit-hidden")
        create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=hidden_account.id)
        seeded_db.flush()
        team_user = CurrentUser.build(id=999999, username="team-viewer", roles=["VIEWER"], owner_scope="TEAM", team_ids=frozenset({42042}))
        statements.clear()
        event.listen(connection, "before_cursor_execute", record_sql)
        try:
            scoped = inventory_ledger(seeded_db, keyword="facet-query-hit", user=team_user)
        finally:
            event.remove(connection, "before_cursor_execute", record_sql)
        assert scoped["total"] == 1
        assert scoped["facet_total"] == 3
        assert scoped["type_counts"] == {"RECOVERY": 2}
        assert scoped["stats"] == result["stats"]
        assert len([sql for sql in statements if " from users " in f" {' '.join(sql.lower().split())} "]) == 1

    def test_inventory_order_summary_reuses_loaded_accounts(self, seeded_db):
        from sqlalchemy import event
        from app.business.orders.router_outputs.list_payload import _order_list_payload

        account = _account(seeded_db, "inventory-summary-reuse")
        order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id)
        expected = _order_list_payload(seeded_db, [order])
        statements = []

        def record_sql(_conn, _cursor, statement, _params, _context, _many):
            statements.append(" ".join(statement.lower().split()))

        connection = seeded_db.connection()
        event.listen(connection, "before_cursor_execute", record_sql)
        try:
            actual = _order_list_payload(seeded_db, [order], accounts=[account])
        finally:
            event.remove(connection, "before_cursor_execute", record_sql)

        assert actual == expected
        assert not any(" from stocks " in sql for sql in statements)

    def test_account_records_inventory_entry_time_to_second(self, seeded_db):
        account = _account(seeded_db, "inventory-entry-time")

        assert account.inventory_entry_at is not None
        assert account.inventory_entry_at.microsecond == 0

    def test_inventory_ledger_filters_by_inventory_operator(self, seeded_db):
        users = list(seeded_db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).all())
        hit = _account(seeded_db, "inventory-operator-hit")
        miss = _account(seeded_db, "inventory-operator-miss")
        hit_order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=hit.id, form_extra={"business_responsible_ids": [users[0].id]})
        create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=miss.id, form_extra={"business_responsible_ids": [users[1].id]})

        result = inventory_ledger(seeded_db, inventory_operator_ids=[users[0].id])

        assert [order.id for _account_row, order in result["items"]] == [hit_order.id]

    def test_inventory_ledger_filters_by_age(self, seeded_db):
        old_account = _account(seeded_db, "inventory-age-old")
        fresh_account = _account(seeded_db, "inventory-age-fresh")
        create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=old_account.id)
        create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=fresh_account.id)
        old_account.inventory_entry_at = datetime.combine(date.today() - timedelta(days=45), datetime.min.time())
        fresh_account.inventory_entry_at = datetime.combine(date.today() - timedelta(days=10), datetime.min.time())
        seeded_db.flush()

        result = inventory_ledger(seeded_db, age_gt_days=30)

        assert [account.id for account, _order in result["items"]] == [old_account.id]

    def test_dashboard_inventory_cards_match_ledger_and_age_filter(self, seeded_client, seeded_db, headers):
        old = _account(seeded_db, "dashboard-inventory-old")
        recent = _account(seeded_db, "dashboard-inventory-recent")
        boundary = _account(seeded_db, "dashboard-inventory-boundary")
        unlinked = _account(seeded_db, "dashboard-inventory-unlinked")
        create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=old.id)
        create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=recent.id)
        create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=boundary.id)
        old.inventory_entry_at = datetime.combine(date.today() - timedelta(days=45), datetime.min.time())
        recent.inventory_entry_at = datetime.combine(date.today() - timedelta(days=10), datetime.min.time())
        boundary.inventory_entry_at = datetime.combine(date.today() - timedelta(days=30), datetime.min.time())
        unlinked.inventory_entry_at = datetime.combine(date.today() - timedelta(days=45), datetime.min.time())
        seeded_db.flush()
        dashboard = seeded_client.get("/api/workbench/summary", headers=headers).json()["inventory"]
        ledger = seeded_client.get("/api/stocks/inventory/ledger", headers=headers).json()
        overdue = seeded_client.get("/api/stocks/inventory/ledger", params={"age_gt_days": 30}, headers=headers).json()
        aging = seeded_client.get("/api/stocks/inventory/ledger", params={"age_gt_days": 7}, headers=headers).json()
        assert dashboard["account_count"] == ledger["total"] == 3
        assert dashboard["overdue_count"] == overdue["total"] == 1
        assert dashboard["aging_count"] == aging["total"] == 3

    def test_pickup_inventory_type_can_be_created_for_th(self, seeded_db):
        account = create_account(
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
            update_account_profile(
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
            update_account_profile(
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
            update_account_profile(
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
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("800"),
            occurred_on=TODAY, actor="pytest",
        )

        updated = update_account_profile(
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

        updated = update_account_profile(
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
        update_account_profile(
            seeded_db,
            account.id,
            actor="pytest",
            account_description="已补充账号说明",
        )

        actions = list(
            seeded_db.scalars(
                select(AuditLog.action)
                .where(AuditLog.entity_id == account.stock_no)
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
                AuditLog.entity_id == account.stock_no,
                AuditLog.action == AuditAction.ACCOUNT_CREATE.value,
            )
        )

        assert audit is not None
        assert audit.actor == "pytest"
        assert audit.after_json["game_type"] == "王者荣耀"

    def test_empty_identifier_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_account(seeded_db, game_account="  ", actor="pytest")
        assert "库存编号必填" in str(exc.value)

    def test_identifier_must_be_text_in_service(self, seeded_db):
        with pytest.raises(Validation, match="库存编号必填"):
            create_account(seeded_db, game_account=123, actor="pytest")

        account = _account(seeded_db, "update-identifier-type")
        with pytest.raises(Validation, match="库存编号必填"):
            update_account_profile(
                seeded_db, account.id, actor="pytest", game_account=123
            )

    def test_duplicate_identifier_allowed_as_repeat_purchase(self, seeded_db):
        """2026-10-28 口径：game_account 不唯一——复购同号各建独立实体。"""
        first = _account(seeded_db, "dup-acc")
        second = create_account(seeded_db, game_account="dup-acc", actor="pytest")
        assert second.id != first.id
        assert second.stock_no != first.stock_no
        assert second.game_account == first.game_account == "dup-acc"

    def test_consignments_enter_inventory_without_purchase_payment(self, seeded_db):
        account = _account(seeded_db, "consignment-acc", inventory_type="CONSIGNMENT")
        assert account.status == AccountStatus.WAITING.value

class TestAccountQueries:
    def test_get_account_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            get_account(seeded_db, 999999)

    def test_list_accounts_filters_by_status(self, seeded_db):
        first = _account(seeded_db, "first-acc")
        second = _account(seeded_db, "second-acc")

        assert [
            item.id for item in list_accounts(seeded_db)
        ] == [first.id, second.id]
        assert [
            item.id
            for item in list_accounts(
                seeded_db, status=AccountStatus.WAITING.value
            )
        ] == [first.id, second.id]
        assert list_accounts(seeded_db, status="VOID") == []

    def test_inventory_and_total_cost_count_only_occupied(self, seeded_db):
        stocked = _account(seeded_db, "stock-acc")
        _buy(seeded_db, stocked, amount="500")

        inv_rows = inventory(seeded_db)
        assert [row["account_id"] for row in inv_rows] == [stocked.id]
        assert inv_rows[0]["cost_amount"] == Decimal("500.00")
        # total_inventory_cost 复用同一库存口径
        assert total_inventory_cost(seeded_db) == Decimal("500.00")

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

        assert pickup in list_accounts(seeded_db)
        assert pickup.id in {row["account_id"] for row in inventory(seeded_db)}
        assert total_inventory_cost(seeded_db) == Decimal("300.00")

    def test_total_inventory_cost_does_not_load_every_account(self, seeded_db):
        account = _account(seeded_db, "aggregate-only")
        _buy(seeded_db, account, amount="42.00")
        seeded_db.flush()
        statements = []
        def track(_conn, _cursor, statement, _params, _context, _many):
            if "from stocks" in statement.lower():
                statements.append(statement.lower())
        connection = seeded_db.connection()
        event.listen(connection, "before_cursor_execute", track)
        try:
            assert total_inventory_cost(seeded_db) == Decimal("42.00")
        finally:
            event.remove(connection, "before_cursor_execute", track)
        assert len(statements) == 1 and "sum(" in statements[0]

class TestAccountsApi:
    def test_legacy_account_list_and_profile_routes_are_removed(
        self, seeded_client, seeded_db, headers
    ):
        account = _account(seeded_db, "legacy-route-target")

        listed = seeded_client.get("/api/stocks", headers=headers)
        assert listed.status_code == 404, listed.text

        updated = seeded_client.patch(
            f"/api/stocks/{account.id}",
            json={"note": "不应通过旧接口修改"},
            headers=headers,
        )
        assert updated.status_code in {404, 405}, updated.text

    def test_legacy_inventory_endpoint_is_removed(self, seeded_client, headers):
        response = seeded_client.get("/api/stocks/inventory", headers=headers)

        # 路径本身会被账号 PATCH 路由占位，但旧库存 GET 已不再提供。
        assert response.status_code == 405

    def test_legacy_inventory_cost_summary_endpoint_is_removed(self, seeded_client, headers):
        response = seeded_client.get(
            "/api/stocks/inventory/cost-summary",
            headers=headers,
        )

        assert response.status_code == 404

    def test_account_endpoints_follow_order_owner_scope(
        self, seeded_client, seeded_db
    ):
        mine = _account(seeded_db, "scoped-mine")
        mine_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="operator",
            account_id=mine.id,
            owner_id=9,
        )
        post_event(
            seeded_db, mine_order.id, event_type="BUY", amount="300",
            occurred_on=TODAY, actor="operator",
        )

        other = _account(seeded_db, "scoped-other")
        other_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            account_id=other.id,
            owner_id=8,
        )
        post_event(
            seeded_db, other_order.id, event_type="BUY", amount="400",
            occurred_on=TODAY, actor="other",
        )

        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        hidden_detail = seeded_client.get(
            f"/api/orders/{other_order.id}/execution-detail", headers=headers
        )
        assert hidden_detail.status_code == 404
        hidden_image = seeded_client.get(
            f"/api/orders/{other_order.id}/execution-images/account_images/0", headers=headers
        )
        assert hidden_image.status_code == 404

        inventory = seeded_client.get(
            "/api/stocks/inventory/ledger",
            params={"limit": 10, "offset": 0},
            headers=headers,
        )
        assert inventory.status_code == 200, inventory.text
        assert [row["account"]["id"] for row in inventory.json()["items"]] == [mine.id]
        assert all("risk_level" not in row["account"] for row in inventory.json()["items"])

    def test_visible_account_does_not_leak_foreign_source_order(
        self, seeded_client, seeded_db
    ):
        account = create_account(
            seeded_db,
            game_account="scope-source-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="operator",
        )
        foreign_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            account_id=account.id,
            owner_id=8,
        )
        post_event(
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
            f"/api/orders/{foreign_order.id}/execution-detail", headers=headers
        )
        assert response.status_code == 404

    def test_read_only_finance_user_can_read_game_password(
        self, seeded_client, seeded_db
    ):
        account = _account(seeded_db, "credential-scope-account", game_password="secret")
        order = _buy(seeded_db, account, amount="300")
        viewer = CurrentUser.build(
            id=9, username="finance-reader", roles=["VIEWER"], owner_scope="ALL"
        )
        viewer_headers = {"Authorization": f"Bearer {build_access_token(viewer)}"}

        detail = seeded_client.get(
            f"/api/orders/{order.id}/execution-detail",
            headers=viewer_headers,
        )
        assert detail.status_code == 200, detail.text
        assert detail.json()["account"]["game_password"] == "secret"

    def test_execution_detail_includes_source_order(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-acc")
        order = _buy(seeded_db, account, amount="300")

        response = seeded_client.get(
            f"/api/orders/{order.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["account"]["source_order_no"] == order.order_no

    def test_order_execution_detail_uses_event_context(self, seeded_client, seeded_db, headers):
        """详情路由必须把事件上下文中的汇总输入传给财务汇总器。"""
        account = _account(seeded_db, "detail-context")
        order = _buy(seeded_db, account, amount="300")

        order_response = seeded_client.get(
            f"/api/orders/{order.id}/execution-detail", headers=headers
        )

        assert order_response.status_code == 200, order_response.text
        assert order_response.json()["finance_summary"]["total_expense"] == "300.00"

    def test_execution_detail_includes_order_linked_standalone_cashflows(
        self, seeded_client, seeded_db, headers
    ):
        account = _account(seeded_db, "detail-standalone-flow-acc")
        order = _buy(seeded_db, account, amount="300")
        pool = _invest_pool(seeded_db)
        flow = create_cashflow(
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
            f"/api/orders/{order.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        order_payload = next(
            item for item in response.json()["orders"] if item["order_id"] == order.id
        )
        assert order_payload["cashflows"] == [
            {
                "flow_no": flow.flow_no,
                "pool_id": pool.id,
                "pool_name": pool.name,
                "occurred_on": TODAY.isoformat(),
                "occurred_at": order_payload["cashflows"][0]["occurred_at"],
                "direction": "OUT",
                "category": "OTHER",
                "amount": "12.00",
                "note": "订单关联的独立支出",
                "operator": "-",
                "operator_user_ids": None,
            }
        ]

    def test_execution_detail_includes_minute_timestamps(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-time-acc")
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        event, _ = post_event(
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
            f"/api/orders/{order.id}/execution-detail", headers=headers
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
        platform = create_counterparty(
            seeded_db, display_name="寄售平台A", type="PLATFORM", actor="pytest"
        )
        order = create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            counterparty_roles=[(platform.id, "PLATFORM")],
        )

        response = seeded_client.get(
            f"/api/orders/{order.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["order_no"] == order.order_no
        assert response.json()["orders"][0]["counterparties"] == [
            {"id": platform.id, "display_name": "寄售平台A", "role": "PLATFORM"}
        ]

    def test_execution_detail_includes_customer_participants(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-customer-party-acc")
        customer = create_customer(seeded_db, display_name="买家A", actor="pytest")
        seller = create_customer(seeded_db, display_name="卖家B", actor="pytest")
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            customer_roles=[(customer.id, "BUYER"), (seller.id, "SELLER")],
        )

        response = seeded_client.get(
            f"/api/orders/{order.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["customers"] == [
            {"id": customer.id, "display_name": "买家A", "role": "BUYER"},
            {"id": seller.id, "display_name": "卖家B", "role": "SELLER"},
        ]

    def test_execution_detail_includes_rebate_amount(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "detail-rebate-acc")
        order = _buy(seeded_db, account, amount="300")
        rebate = create_rebate(
            seeded_db,
            source_order_id=order.id,
            amount=Decimal("300"),
            collected_on=TODAY,
            rebate_type="BUY",
            channel="买号返点",
            actor="pytest",
        )
        response = seeded_client.get(
            f"/api/orders/{order.id}/execution-detail", headers=headers
        )

        assert response.status_code == 200, response.text
        assert response.json()["orders"][0]["rebates"] == [{
            "id": rebate.id,
            "rebate_no": rebate.rebate_no,
            "rebate_type": "BUY",
            "channel": "买号返点",
            "amount": "300.00",
            "collected_on": TODAY.isoformat(),
            "collected_at": datetime.combine(TODAY, rebate.created_at.time()).isoformat(),
        }]
        finance_rows = response.json()["detail_view"]["finance_rows"]
        assert [row["type"] for row in finance_rows] == ["回收成本", "返点收入"]

