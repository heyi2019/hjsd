"""orders 订单/事件契约测试（ORD-01/02、FIN-01/03）。

与 test_orders.py / test_bughunt.py / test_m2.py 的分工：既有文件已覆盖四类业务建单、
BUY/COST/SELL/PAYMENT/DELIVER/CANCEL(无 offset) 过账、状态机、路由缺失等主路径；
本文件补NotFound/越权/过滤/非法入参分支、`_opposite_direction` 三分支、
`_apply_account_effect` 防御与 CANCEL 分支、以及 3 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CapitalType,
    CustomerStatus,
    InstallmentContractType,
    OrderStatus,
)
from app.accounts import service as accounts_service
from app.installments import service as installments_service
from app.finance import service as finance_service
from app.parties import service as parties_service
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent, OrderLink
from app.domain.users import User
from app.foundation import service as foundation_service
from app.orders import service as order_service

D = date(2026, 10, 4)


def _order(seeded_db, *, order_type="HS", account_id=None, owner_id=None, trade_date=D):
    if order_type == "HS" and account_id is None:
        account_id = accounts_service.create_account(
            seeded_db,
            game_account=f"orders-contract-{uuid4().hex[:10]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        ).id
    return order_service.create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
    )


def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )


# ------------------------------------------------------------------ 建单校验
class TestCreateOrderValidation:
    def test_order_and_account_live_fields_round_trip_through_api(
        self, seeded_client, seeded_db, headers
    ):
        parties_service.create_field_definition(
            seeded_db,
            entity_type="order",
            field_key="origin_note",
            label="来源备注",
            actor="pytest",
        )
        parties_service.create_field_definition(
            seeded_db,
            entity_type="account",
            field_key="selling_point",
            label="账号卖点",
            actor="pytest",
        )

        created = seeded_client.post(
            "/api/v1/orders",
            headers=headers,
            json={
                "order_type": "HS",
                "trade_date": "2026-10-04",
                "extra_values": {"origin_note": "朋友转介绍"},
                "account": {
                    "game_account": "api-live-field-account",
                    "extra_values": {"selling_point": "稀有皮肤"},
                },
            },
        )
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["extra_values"] == {"origin_note": "朋友转介绍"}

        detail = seeded_client.get(
            f"/api/v1/orders/{body['id']}", headers=headers
        )
        assert detail.status_code == 200
        assert detail.json()["extra_values"] == {"origin_note": "朋友转介绍"}

        accounts = seeded_client.get("/api/v1/accounts", headers=headers)
        assert accounts.status_code == 200
        account = next(
            item for item in accounts.json()
            if item["id"] == body["account_id"]
        )
        assert account["extra_values"] == {"selling_point": "稀有皮肤"}

    def test_order_owner_must_be_active(self, seeded_db):
        owner = seeded_db.get(User, 1)
        owner.is_active = False
        seeded_db.flush()

        with pytest.raises(Validation, match="订单负责人必须是启用用户"):
            order_service.create_order(
                seeded_db,
                order_type="DFQ",
                trade_date=D,
                owner_id=owner.id,
                actor="pytest",
            )

    def test_order_links_record_source_follow_up_and_split_share(self, seeded_db):
        source = _order(seeded_db, order_type="DFQ")
        follow_up = _order(seeded_db, order_type="HS")

        link = order_service.create_order_link(
            seeded_db,
            follow_up.id,
            related_order_id=source.id,
            relation_type="SOURCE",
            split_ratio=Decimal("50"),
            split_amount=Decimal("400"),
            note="来源订单",
            actor="pytest",
        )

        assert link.source_order_id == source.id
        assert link.target_order_id == follow_up.id
        listed = order_service.list_order_links(seeded_db, follow_up.id)
        assert listed[0]["direction"] == "SOURCE"
        assert listed[0]["source_order_no"] == source.order_no
        assert listed[0]["split_ratio"] == Decimal("50.00")

        with pytest.raises(Validation, match="订单关联已存在"):
            order_service.create_order_link(
                seeded_db,
                source.id,
                related_order_id=follow_up.id,
                relation_type="FOLLOW_UP",
                actor="pytest",
            )

    def test_order_link_rejects_self_and_invalid_relation(self, seeded_db):
        order = _order(seeded_db, order_type="DFQ")
        with pytest.raises(Validation, match="不能关联自身"):
            order_service.create_order_link(
                seeded_db,
                order.id,
                related_order_id=order.id,
                relation_type="SOURCE",
                actor="pytest",
            )
        with pytest.raises(Validation, match="关联方向无效"):
            order_service.create_order_link(
                seeded_db,
                order.id,
                related_order_id=999999,
                relation_type="UNKNOWN",
                actor="pytest",
            )

    def test_installment_gate_flags_must_be_boolean_in_service(self, seeded_db):
        order = _order(seeded_db, order_type="HS")
        with pytest.raises(Validation, match="allow_installment_payment 必须为布尔值"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
                allow_installment_payment="false",
            )
        with pytest.raises(Validation, match="allow_installment_delivery 必须为布尔值"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
                allow_installment_delivery="false",
            )

    def test_finance_can_post_buy_sell_but_not_other_order_events(self, seeded_client, seeded_db):
        finance_account = seeded_db.get(User, 9)
        finance_account.role = "FINANCE"
        finance_account.owner_scope = "SELF"
        finance_account.pool_ids = [1]
        seeded_db.flush()

        account = accounts_service.create_account(
            seeded_db,
            game_account=f"finance-event-{uuid4().hex[:10]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order = order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="pytest",
            account_id=account.id,
            owner_id=9,
        )
        token = build_access_token(
            CurrentUser.build(
                id=9,
                username="seeduser9",
                roles=["FINANCE"],
                owner_scope="SELF",
                pool_ids=frozenset({1}),
            )
        )
        auth = {"Authorization": f"Bearer {token}"}

        buy = seeded_client.post(
            f"/api/v1/orders/{order.id}/events",
            headers=auth,
            json={"event_type": "BUY", "amount": "100", "occurred_on": D.isoformat(), "pool_id": 1},
        )
        assert buy.status_code == 201, buy.text

        sell = seeded_client.post(
            f"/api/v1/orders/{order.id}/events",
            headers=auth,
            json={"event_type": "SELL", "amount": "120", "occurred_on": D.isoformat(), "pool_id": 1},
        )
        assert sell.status_code == 201, sell.text

        cost = seeded_client.post(
            f"/api/v1/orders/{order.id}/events",
            headers=auth,
            json={
                "event_type": "COST",
                "amount": "10",
                "occurred_on": D.isoformat(),
                "pool_id": 1,
                "flow_category": "FEE",
            },
        )
        assert cost.status_code == 403, cost.text
        assert cost.json()["code"] == ErrorCode.PERMISSION_DENIED

    def test_order_creation_validates_participants_before_creating_account(self, seeded_db):
        customer = parties_service.create_customer(
            seeded_db, display_name="已停用客户", actor="pytest"
        )
        parties_service.set_customer_status(
            seeded_db, customer.id, CustomerStatus.DISABLED.value, actor="pytest"
        )

        with pytest.raises(Validation, match="不可作为新订单参与方"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="operator",
                account_profile={"game_account": "should-not-be-created"},
                customer_roles=[(customer.id, "SELLER")],
                note="atomic-participant-validation",
            )

        seeded_db.commit()
        assert seeded_db.scalar(
            select(Account.id).where(Account.game_account == "should-not-be-created")
        ) is None
        assert seeded_db.scalar(
            select(Order.id).where(Order.note == "atomic-participant-validation")
        ) is None

    def test_hs_buy_requires_inventory_account(self, seeded_db):
        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=D, actor="pytest"
        )

        with pytest.raises(Validation, match="库存账号"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
            )

    def test_order_commission_fields_are_closed_at_database_boundary(self, seeded_db):
        order = _order(seeded_db, order_type="DG")
        order.commission_mode = "UNKNOWN"
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_event_delivery_mode_is_closed_at_database_boundary(self, seeded_db):
        order = _order(seeded_db)
        seeded_db.add(
            OrderEvent(
                event_no="HS-DB-DELIVERY",
                order_id=order.id,
                event_type="BUY",
                amount=Decimal("0"),
                portion="GROSS",
                occurred_on=D,
                delivery_mode="UNKNOWN",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_order_link_status_is_closed_at_database_boundary(self, seeded_db):
        seeded_db.add(
            Order(
                order_no="HS-INVALID-LINK-STATUS",
                order_type="HS",
                capital_type=CapitalType.STOCK.value,
                trade_date=D,
                status=OrderStatus.ACTIVE.value,
                link_status="AUTO_MATCHED",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_order_amounts_cannot_be_negative_in_database(self, seeded_db):
        seeded_db.add(
            Order(
                order_no="HS-NEGATIVE-AMOUNT",
                order_type="HS",
                capital_type=CapitalType.STOCK.value,
                trade_date=D,
                listing_price=Decimal("-1"),
                status=OrderStatus.ACTIVE.value,
                link_status="LINKED",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_unknown_order_type_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            order_service.create_order(
                seeded_db, order_type="ZZ", trade_date=D, actor="pytest"
            )
        assert "不存在" in str(exc.value)

    def test_invalid_capital_type_rejected_before_database_constraint(self, seeded_db):
        with pytest.raises(Validation, match="capital_type"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                capital_type="NOT_A_CAPITAL_TYPE",
            )
        with pytest.raises(Validation, match="capital_type"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                capital_type="",
            )

    def test_invalid_order_amounts_are_business_errors_in_service(self, seeded_db):
        with pytest.raises(Validation, match="不能为负数"):
            order_service.create_order(
                seeded_db,
                order_type="DG",
                trade_date=D,
                actor="pytest",
                listing_price=Decimal("-1"),
            )

        order = _order(seeded_db)
        with pytest.raises(Validation, match="必须大于 0"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("0"),
                occurred_on=D,
                actor="pytest",
            )

    @pytest.mark.parametrize("field", ["event_type", "portion"])
    def test_event_enum_inputs_reject_unhashable_values_as_validation(
        self, seeded_db, field
    ):
        order = _order(seeded_db)
        values = {
            "event_type": [],
            "portion": {},
        }
        kwargs = {
            "event_type": "BUY",
            "portion": "PRINCIPAL",
            "amount": "100.00",
            "occurred_on": D,
            "actor": "pytest",
        }
        kwargs[field] = values[field]

        with pytest.raises(Validation) as exc:
            order_service.post_event(seeded_db, order.id, **kwargs)
        assert exc.value.details["field"] == field

    def test_duplicate_participant_role_rejected_before_unique_constraint(
        self, seeded_db
    ):
        customer = parties_service.create_customer(
            seeded_db, display_name="重复角色客户", actor="pytest"
        )
        with pytest.raises(Validation, match="不可重复"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                customer_roles=[
                    (customer.id, "SELLER"),
                    (customer.id, "SELLER"),
                ],
            )

    def test_participant_roles_must_match_order_type(self, seeded_db):
        customer = parties_service.create_customer(
            seeded_db, display_name="业务角色客户", actor="pytest"
        )
        supplier = parties_service.create_counterparty(
            seeded_db, display_name="供货方", type="SUPPLIER", actor="pytest"
        )

        with pytest.raises(Validation, match="TH 不允许客户角色 SELLER"):
            order_service.create_order(
                seeded_db,
                order_type="TH",
                trade_date=D,
                actor="pytest",
                customer_roles=[(customer.id, "SELLER")],
            )

        with pytest.raises(Validation, match="TH 不允许合作方角色 SUPPLIER"):
            order_service.create_order(
                seeded_db,
                order_type="TH",
                trade_date=D,
                actor="pytest",
                counterparty_roles=[(supplier.id, "SUPPLIER")],
            )

    def test_participant_id_shape_is_rejected_before_database_flush(self, seeded_db):
        with pytest.raises(Validation, match="参与方 ID"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                customer_roles=[("not-an-id", "SELLER")],
            )

    def test_disabled_order_type_rejected(self, seeded_db):
        definition = foundation_service.get_order_type_by_code(seeded_db, "HS")
        foundation_service.set_order_type_active(
            seeded_db, definition.id, False, actor="pytest"
        )
        with pytest.raises(Validation) as exc:
            _order(seeded_db)
        assert "已停用" in str(exc.value)

    def test_dfq_cannot_link_inventory_account(self, seeded_db):
        account = Account(
            inventory_no="ACC-DFQ-1",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation) as exc:
            _order(seeded_db, order_type="DFQ", account_id=account.id)

        assert "DFQ 代分期订单不关联库存账号" in str(exc.value)

    def test_order_rejects_mismatched_existing_account_context(self, seeded_db):
        account = Account(
            inventory_no="ACC-WRONG-CONTEXT",
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation, match="库存账号业务类型与订单类型不匹配"):
            _order(seeded_db, order_type="DG", account_id=account.id)

    def test_order_rejects_existing_account_without_context(self, seeded_db):
        account = Account(
            inventory_no="ACC-MISSING-CONTEXT",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation, match="库存账号业务类型与订单类型不匹配"):
            _order(seeded_db, order_type="HS", account_id=account.id)

    def test_order_account_profile_rejects_unknown_fields_in_service(self, seeded_db):
        with pytest.raises(Validation, match="订单账号资料字段校验失败"):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                account_profile={
                    "game_account": "profile-invalid",
                    "unknown": "不应写入",
                },
            )

    def test_scoped_user_cannot_attach_foreign_account(self, seeded_db):
        account = Account(
            inventory_no="ACC-SCOPE-1",
            game_account="scope-account",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="another-operator",
            updated_by="another-operator",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(NotFound):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="operator",
                account_id=account.id,
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_attach_foreign_customer(self, seeded_db):
        customer = parties_service.create_customer(
            seeded_db,
            display_name="foreign-customer",
            actor="another-operator",
            owner_id=8,
        )

        with pytest.raises(NotFound):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="operator",
                customer_roles=[(customer.id, "SELLER")],
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_assign_order_to_other_owner_in_service(
        self, seeded_db
    ):
        order = order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="operator",
            owner_id=1,
            user=_scoped_user(),
        )
        assert order.owner_id == 9

    def test_order_owner_must_exist_in_service(self, seeded_db):
        with pytest.raises(Validation, match="订单负责人不存在"):
            _order(seeded_db, owner_id=999999)

    def test_dg_commission_terms_are_persisted(self, seeded_db):
        order = order_service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=D,
            actor="pytest",
            listing_price="1200.00",
            service_fee="120.00",
            commission_mode="DEDUCT_FROM_SETTLEMENT",
            commission_payer="CONSIGNOR",
            expected_settlement_date=date(2026, 10, 20),
        )

        assert order.listing_price == Decimal("1200.00")
        assert order.service_fee == Decimal("120.00")
        assert order.commission_mode == "DEDUCT_FROM_SETTLEMENT"
        assert order.commission_payer == "CONSIGNOR"
        assert order.expected_settlement_date == date(2026, 10, 20)

    def test_dg_commission_terms_reject_unhashable_values(self, seeded_db):
        with pytest.raises(Validation, match="抽成方式无效"):
            order_service.create_order(
                seeded_db,
                order_type="DG",
                trade_date=D,
                actor="pytest",
                commission_mode=[],
                commission_payer="CONSIGNOR",
            )

    def test_dg_service_fee_cannot_exceed_listing_price(self, seeded_db):
        with pytest.raises(Validation, match="服务费不能超过挂售价"):
            order_service.create_order(
                seeded_db,
                order_type="DG",
                trade_date=D,
                actor="pytest",
                listing_price="100.00",
                service_fee="100.01",
            )

    def test_dfq_account_snapshot_does_not_create_inventory_account(self, seeded_db):
        order = order_service.create_order(
            seeded_db,
            order_type="DFQ",
            trade_date=D,
            actor="pytest",
            account_snapshot={
                "game_type": "王者荣耀",
                "game_account": "dfq-text-account",
                "game_password": "secret",
                "channel_region": "安卓一区",
                "note": "仅订单文本",
            },
        )

        assert order.account_id is None
        assert order.account_snapshot["game_account"] == "dfq-text-account"
        assert seeded_db.scalar(
            select(Account.id).where(Account.game_account == "dfq-text-account")
        ) is None

    def test_th_account_snapshot_does_not_create_inventory_account(self, seeded_db):
        order = order_service.create_order(
            seeded_db,
            order_type="TH",
            trade_date=D,
            actor="pytest",
            account_snapshot={
                "game_type": "王者荣耀",
                "game_account": "th-text-account",
                "game_password": "secret",
                "channel_region": "安卓一区",
                "note": "提号只保留订单文本",
            },
        )

        assert order.account_id is None
        assert order.account_snapshot["game_account"] == "th-text-account"
        assert seeded_db.scalar(
            select(Account.id).where(Account.game_account == "th-text-account")
        ) is None

    def test_th_rejects_inventory_account_link(self, seeded_db):
        account = Account(
            inventory_no="ACC-TH-NOT-INVENTORY",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation, match="提号订单不关联库存账号"):
            order_service.create_order(
                seeded_db,
                order_type="TH",
                trade_date=D,
                actor="pytest",
                account_id=account.id,
            )

    def test_dfq_account_snapshot_rejects_unknown_fields(self, seeded_db):
        with pytest.raises(Validation, match="订单账号快照字段校验失败"):
            order_service.create_order(
                seeded_db,
                order_type="DFQ",
                trade_date=D,
                actor="pytest",
                account_snapshot={
                    "game_account": "dfq-invalid-snapshot",
                    "account_note": "不属于订单账号文本字段",
                },
            )

    def test_account_snapshot_rejects_removed_legacy_account_fields(self, seeded_db):
        with pytest.raises(Validation, match="订单账号快照字段校验失败"):
            order_service.create_order(
                seeded_db,
                order_type="DFQ",
                trade_date=D,
                actor="pytest",
                account_snapshot={
                    "game_account": "dfq-legacy-region",
                    "region": "旧字段",
                },
            )

    def test_account_snapshot_does_not_accept_inventory_media_fields(self, seeded_db):
        with pytest.raises(Validation, match="订单账号快照字段校验失败"):
            order_service.create_order(
                seeded_db,
                order_type="DFQ",
                trade_date=D,
                actor="pytest",
                account_snapshot={
                    "game_account": "dfq-no-media",
                    "account_description": "订单快照不承载营销资料",
                    "account_images": ["image-1"],
                },
            )


# ------------------------------------------------------------------ 查询与作用域
class TestGetAndListOrders:
    def test_get_order_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            order_service.get_order(seeded_db, 999999)

    def test_active_order_can_update_note_before_posting(self, seeded_db):
        order = _order(seeded_db)
        updated = order_service.update_order(
            seeded_db, order.id, actor="operator", note="补充客户备注"
        )
        assert updated.note == "补充客户备注"

    def test_order_trade_date_cannot_be_cleared(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="订单日期不能清空"):
            order_service.update_order(
                seeded_db, order.id, actor="operator", trade_date=None
            )

    def test_posted_order_cannot_update_accounting_fields_but_can_update_note(
        self, seeded_db
    ):
        order = _order(seeded_db, order_type="DG")
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("200"),
            occurred_on=D,
            actor="pytest",
            portion="GROSS",
        )
        with pytest.raises(Validation, match="过账事件"):
            order_service.update_order(
                seeded_db, order.id, actor="operator", listing_price=Decimal("300")
            )
        updated = order_service.update_order(
            seeded_db, order.id, actor="operator", note="仅改备注"
        )
        assert updated.note == "仅改备注"

    def test_order_cancel_requires_no_posted_events(self, seeded_db):
        order = _order(seeded_db)
        cancelled = order_service.cancel_order(
            seeded_db, order.id, actor="operator", reason="客户撤单"
        )
        assert cancelled.status == "CANCELLED"

        posted = _order(seeded_db)
        order_service.post_event(
            seeded_db, posted.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=D, actor="pytest"
        )
        with pytest.raises(Validation, match="过账事件"):
            order_service.cancel_order(
                seeded_db, posted.id, actor="operator", reason="不能直接作废"
            )

    def test_get_order_owner_scope_forbidden(self, seeded_db):
        # 他人 owner 的订单对 SELF 作用域用户同样 404（不泄露存在性）
        order = _order(seeded_db, owner_id=1)
        with pytest.raises(NotFound):
            order_service.get_order(seeded_db, order.id, _scoped_user())

    def test_scoped_user_cannot_post_event_to_foreign_order(self, seeded_db):
        order = _order(seeded_db, owner_id=1)
        with pytest.raises(NotFound):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("10"),
                occurred_on=D,
                actor="operator",
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_post_event_to_foreign_pool(self, seeded_db):
        order = _order(seeded_db, owner_id=9)
        scoped = CurrentUser.build(
            id=9,
            username="operator",
            roles=["OPERATOR"],
            owner_scope="SELF",
            pool_ids=frozenset({2}),
        )
        with pytest.raises(NotFound):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("10"),
                occurred_on=D,
                actor="operator",
                pool_id=1,
                user=scoped,
            )

    def test_list_orders_filters_and_scope(self, seeded_db):
        mine = _order(seeded_db, owner_id=9)
        _order(seeded_db, order_type="TH", owner_id=1)
        order_service.post_event(
            seeded_db, mine.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )

        by_type = order_service.list_orders(seeded_db, order_type="HS")
        assert [o.id for o in by_type] == [mine.id]
        by_status = order_service.list_orders(seeded_db, status="ACTIVE")
        assert mine.id in [o.id for o in by_status]  # 创建即 ACTIVE，过账不翻转状态

        scoped = order_service.list_orders(seeded_db, user=_scoped_user())
        assert [o.id for o in scoped] == [mine.id]
        # 无 user 不过滤：两张单都可见
        assert len(order_service.list_orders(seeded_db)) == 2


# ------------------------------------------------------------------ 事件入参
class TestPostEventValidation:
    def test_invalid_portion_rejected_before_event_write(self, seeded_db):
        order = _order(seeded_db)

        with pytest.raises(Validation, match="portion"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
                portion="INVALID",
            )

        assert not seeded_db.scalar(
            select(OrderEvent.id).where(OrderEvent.order_id == order.id)
        )

    def test_invalid_cost_category_leaves_no_event_or_cashflow(self, seeded_db):
        order = _order(seeded_db)

        with pytest.raises(Validation):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="COST",
                amount="10.00",
                occurred_on=D,
                actor="pytest",
                flow_category="INVALID",
            )

        assert seeded_db.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all() == []
        assert seeded_db.scalars(
            select(Cashflow).where(Cashflow.order_id == order.id)
        ).all() == []

        with pytest.raises(Validation, match="资金分类"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="COST",
                amount="1.00",
                occurred_on=D,
                actor="pytest",
                flow_category=[],
            )

    def test_invalid_event_type_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="BOGUS", amount="1.00",
                occurred_on=D, actor="pytest",
            )
        assert "事件类型" in str(exc.value)

    def test_transfer_removed_from_event_types(self, seeded_db):
        """划转已从 EventType 移除：不再是「可枚举但不可过账」，而是非法事件类型。"""
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="TRANSFER", amount="1.00",
                occurred_on=D, actor="pytest",
            )
        assert "事件类型" in str(exc.value)

    def test_deliver_requires_note(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="DELIVER",
                occurred_on=D, actor="pytest", delivery_mode="CUSTOMER_SELF",
            )
        assert "凭证" in str(exc.value)
        with pytest.raises(Validation, match="凭证"):
            order_service.post_event(
                seeded_db, order.id, event_type="DELIVER",
                occurred_on=D, actor="pytest", delivery_mode="CUSTOMER_SELF",
                note=123,
            )

    def test_post_event_to_inactive_pool_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(NotFound):
            order_service.post_event(
                seeded_db, order.id, event_type="BUY", amount="1.00",
                occurred_on=D, actor="pytest", pool_id=999999,
            )


# ------------------------------------------------------------------ 冲销方向
class TestCancelOffsetDirection:
    def test_opposite_direction_three_branches(self, seeded_db):
        from sqlalchemy import select

        from app.domain.enums import Direction
        from app.domain.trade import Cashflow

        # 分支一：offset 指向 BUY → 方向取反为 IN（每分支独立建单）
        order_a = _order(seeded_db)
        buy_a, _ = order_service.post_event(
            seeded_db, order_a.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        cancel_a, _ = order_service.post_event(
            seeded_db, order_a.id, event_type="CANCEL", amount="100.00",
            occurred_on=D, actor="pytest", offset_event_id=buy_a.id,
            reason="撤回全部买入款",
        )
        assert order_a.status == "CANCELLED"

        # 分支二：offset 指向 SELL → 方向取反为 OUT
        order_b = _order(seeded_db, order_type="TH")
        buy_event, _ = order_service.post_event(
            seeded_db, order_b.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        sell_event, _ = order_service.post_event(
            seeded_db, order_b.id, event_type="SELL", amount="150.00",
            occurred_on=D, actor="pytest", offset_event_id=buy_event.id,
        )
        cancel_b, _ = order_service.post_event(
            seeded_db, order_b.id, event_type="CANCEL", amount="10.00",
            occurred_on=D, actor="pytest", offset_event_id=sell_event.id,
            reason="买家部分退款",
        )

        # 分支三：offset 指向不存在的事件 → NotFound。FK 全局强制使经 post_event
        # 不可达（INSERT order_events 即失败，校验在 flush 之后），直调私有函数覆盖
        with pytest.raises(NotFound):
            order_service._opposite_direction(999999, seeded_db)

        flows = {
            row.id: row
            for row in seeded_db.scalars(select(Cashflow)).all()
        }
        assert flows[cancel_a.id].direction == Direction.IN.value
        assert flows[cancel_b.id].direction == Direction.OUT.value

    def test_cancel_requires_reason_and_th_offset(self, seeded_db):
        hs = _order(seeded_db)
        _hs_buy, _ = order_service.post_event(
            seeded_db, hs.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_reason:
            order_service.post_event(
                seeded_db, hs.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest",
            )
        assert "原因" in str(missing_reason.value)

        with pytest.raises(Validation, match="offset_event_id"):
            order_service.post_event(
                seeded_db, hs.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason="回收退回",
            )

        th = _order(seeded_db, order_type="TH")
        order_service.post_event(
            seeded_db, th.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_offset:
            order_service.post_event(
                seeded_db, th.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason="同行未付成功",
            )
        assert "offset_event_id" in str(missing_offset.value)

    def test_cancel_reasons_require_text_values(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="订单作废必须填写原因"):
            order_service.cancel_order(
                seeded_db, order.id, actor="pytest", reason=123
            )

        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation, match="CANCEL 必须填写冲销原因"):
            order_service.post_event(
                seeded_db, order.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason=123,
            )

    def test_cancel_cannot_exceed_offset_remaining_or_change_pool(self, seeded_db):
        order = _order(seeded_db, order_type="TH")
        buy, _ = order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest", pool_id=1,
        )

        with pytest.raises(Validation) as wrong_pool:
            order_service.post_event(
                seeded_db, order.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                pool_id=2, reason="资金池更正",
            )
        assert "资金池" in str(wrong_pool.value)

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="60.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退款",
        )
        assert order.status == OrderStatus.ACTIVE.value
        with pytest.raises(Validation) as over_cancel:
            order_service.post_event(
                seeded_db, order.id, event_type="CANCEL", amount="50.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                reason="再次退款",
            )
        assert "剩余可冲销" in str(over_cancel.value)

    def test_cancel_offset_must_belong_to_the_same_order(self, seeded_db):
        first = _order(seeded_db)
        second = _order(seeded_db, order_type="TH")
        buy_event, _ = order_service.post_event(
            seeded_db,
            second.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="pytest",
        )
        order_event, _ = order_service.post_event(
            seeded_db,
            second.id,
            event_type="SELL",
            amount="150.00",
            occurred_on=D,
            actor="pytest",
            offset_event_id=buy_event.id,
        )

        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db,
                first.id,
                event_type="CANCEL",
                amount="10.00",
                occurred_on=D,
                actor="pytest",
                offset_event_id=order_event.id,
                reason="跨订单冲销测试",
            )

        assert exc.value.code == ErrorCode.VALIDATION_ERROR
        assert "同一订单" in str(exc.value)

    def test_cancel_cost_reverses_cashflow_to_income(self, seeded_db):
        order = _order(seeded_db)
        cost, _ = order_service.post_event(
            seeded_db,
            order.id,
            event_type="COST",
            amount="30.00",
            occurred_on=D,
            actor="pytest",
        )

        _cancel, flow = order_service.post_event(
            seeded_db,
            order.id,
            event_type="CANCEL",
            amount="30.00",
            occurred_on=D,
            actor="pytest",
            offset_event_id=cost.id,
            reason="费用退回",
        )

        assert flow.direction == "IN"


# ------------------------------------------------------------------ 账号效果
class TestAccountEffect:
    def test_event_updates_account_operator(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-OPERATOR",
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)

        order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="500.00",
            occurred_on=D,
            actor="buyer",
        )

        assert account.updated_by == "buyer"

    def test_cancel_reverses_cost_and_voids_account(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-1",
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        buy, _ = order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        assert account.cost_amount == 500
        assert account.status == AccountStatus.IN_STOCK.value

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="500.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="回收退回",
        )
        assert account.cost_amount == 0
        assert account.status == AccountStatus.VOID.value

    def test_partial_buy_cancel_keeps_account_in_stock(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-PARTIAL",
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        buy, _ = order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="100.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退回",
        )

        assert account.cost_amount == Decimal("400.00")
        assert account.status == AccountStatus.IN_STOCK.value

    def test_cancel_sell_restores_stock_without_reducing_cost(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-SELL-CANCEL",
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        sell, _ = order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="pytest",
        )
        assert account.status == AccountStatus.SOLD.value

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="800.00",
            occurred_on=D, actor="pytest", offset_event_id=sell.id,
            reason="售出撤销",
        )

        assert account.cost_amount == Decimal("500.00")
        assert account.status == AccountStatus.IN_STOCK.value

    def test_payment_event_cannot_bypass_installment_service(self, seeded_db):
        order = _order(seeded_db, order_type="DFQ")
        installments_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
            principal=Decimal("1000"),
            periods=1,
            per_period=Decimal("1000"),
            first_due_on=D,
            actor="pytest",
        )

        with pytest.raises(Validation, match="分期收款流程"):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="PAYMENT",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
            )

    def test_cancel_payment_is_rejected_until_schedule_reversal_is_supported(self, seeded_db):
        order = _order(seeded_db, order_type="DFQ")
        contract = installments_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
            principal=to_money("1000"),
            periods=1,
            per_period=to_money("1000"),
            first_due_on=D,
            actor="pytest",
        )
        installments_service.pay(
            seeded_db, contract.id, amount="100.00", paid_on=D, actor="pytest"
        )
        payment = seeded_db.scalar(
            select(OrderEvent)
            .where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == "PAYMENT",
            )
            .order_by(OrderEvent.id.desc())
        )
        assert payment is not None

        with pytest.raises(Validation) as exc:
            order_service.post_event(
                seeded_db, order.id, event_type="CANCEL", amount="100.00",
                occurred_on=D, actor="pytest", offset_event_id=payment.id,
                reason="收款撤销",
            )

        assert "分期" in str(exc.value)

    def test_account_none_branch_is_defensive(self, seeded_db):
        # FK 全局强制使 ORM 路径不可达（账号删除是 SET NULL）；直调私有函数覆盖防御分支
        ghost = Order(
            order_no="HS-GHOST",
            order_type="HS",
            capital_type=CapitalType.STOCK.value,
            trade_date=D,
            status=OrderStatus.ACTIVE.value,
            account_id=999999,
            created_by="pytest",
            updated_by="pytest",
        )
        assert order_service._apply_account_effect(
            seeded_db, ghost, "BUY", Decimal("100")
        ) is None


# ------------------------------------------------------------------ 池余额
class TestPoolBalance:
    def test_pool_balance_service_enforces_pool_visibility(self, seeded_db):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )

        with pytest.raises(NotFound):
            order_service.pool_balance(seeded_db, 2, user=scoped)

    def test_pool_balance_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            order_service.pool_balance(seeded_db, 999999)


# ------------------------------------------------------------------ 路由层
class TestOrdersApi:
    def test_dfq_snapshot_populates_safe_order_list_fields(
        self, seeded_client, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "account_snapshot": {
                    "game_type": "王者荣耀",
                    "game_account": "dfq-list-account",
                    "game_password": "must-not-list",
                    "channel_region": "安卓一区",
                    "platform": "平台A",
                },
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text

        listed = seeded_client.get("/api/v1/orders", headers=headers)

        assert listed.status_code == 200, listed.text
        row = next(item for item in listed.json() if item["id"] == created.json()["id"])
        assert row["account_game_type"] == "王者荣耀"
        assert row["account_game_account"] == "dfq-list-account"
        assert row["account_channel_region"] == "安卓一区"
        assert row["account_platform"] == "平台A"
        assert row["account_snapshot"] is None

    def test_viewer_order_detail_redacts_dfq_game_password(
        self, seeded_client, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "account_snapshot": {
                    "game_type": "王者荣耀",
                    "game_account": "dfq-secret-account",
                    "game_password": "secret-password",
                },
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text

        viewer = CurrentUser.build(
            id=5,
            username="finance-reader",
            roles=["VIEWER"],
            owner_scope="ALL",
        )
        viewer_headers = {"Authorization": f"Bearer {build_access_token(viewer)}"}
        fetched = seeded_client.get(
            f"/api/v1/orders/{created.json()['id']}",
            headers=viewer_headers,
        )

        assert fetched.status_code == 200, fetched.text
        snapshot = fetched.json()["account_snapshot"]
        assert snapshot["game_account"] == "dfq-secret-account"
        assert snapshot["game_password"] is None

    def test_order_request_rejects_removed_or_unknown_fields(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "risk_level": "HIGH",
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_order_role_payload_requires_the_matching_participant_id(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "customer_roles": [{"role": "SELLER"}],
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_update_dfq_account_snapshot_uses_order_account_contract(
        self, seeded_client, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "DFQ", "trade_date": D.isoformat()},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        order_id = created.json()["id"]

        invalid = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={"account_snapshot": {"game_type": "王者荣耀"}},
            headers=headers,
        )
        assert invalid.status_code == 422, invalid.text

        unknown = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={
                "account_snapshot": {
                    "game_account": "dfq-edit-account",
                    "unknown_field": "不能静默丢弃",
                }
            },
            headers=headers,
        )
        assert unknown.status_code == 422, unknown.text

        valid = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={
                "account_snapshot": {
                    "game_account": "dfq-edit-account",
                    "game_type": "王者荣耀",
                }
            },
            headers=headers,
        )
        assert valid.status_code == 200, valid.text
        assert valid.json()["account_snapshot"]["game_account"] == "dfq-edit-account"

    def test_update_th_account_snapshot_uses_order_account_contract(
        self, seeded_client, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "TH",
                "trade_date": D.isoformat(),
                "account_snapshot": {"game_account": "th-before"},
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text

        updated = seeded_client.patch(
            f"/api/v1/orders/{created.json()['id']}",
            json={"account_snapshot": {"game_account": "th-after", "game_type": "王者荣耀"}},
            headers=headers,
        )

        assert updated.status_code == 200, updated.text
        assert updated.json()["account_snapshot"]["game_account"] == "th-after"

    def test_update_and_cancel_order_api(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "HS", "trade_date": D.isoformat()},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        order_id = created.json()["id"]

        updated = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={"note": "接口补充备注"},
            headers=headers,
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["note"] == "接口补充备注"

        cancelled = seeded_client.post(
            f"/api/v1/orders/{order_id}/cancel",
            json={"reason": "接口撤单"},
            headers=headers,
        )
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["status"] == "CANCELLED"

    def test_scoped_user_cannot_choose_foreign_pool_for_composite_dfq(
        self, seeded_client, seeded_db
    ):
        user = CurrentUser.build(
            id=9,
            username="operator",
            roles=["OPERATOR"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        headers = {"Authorization": f"Bearer {build_access_token(user)}"}
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "initial_buy": {
                    "amount": "800.00",
                    "occurred_on": D.isoformat(),
                    "pool_id": 2,
                    "portion": "PRINCIPAL",
                },
                "installment": {
                    "contract_type": "ADVANCE_PURCHASE",
                    "principal": "800.00",
                    "periods": 1,
                    "first_due_on": "2026-11-01",
                    "per_period": "800.00",
                },
            },
            headers=headers,
        )
        assert response.status_code == 404, response.text

    def test_scoped_user_cannot_assign_created_order_to_other_owner(
        self, seeded_client, seeded_db
    ):
        from app.core.security import build_access_token

        user = _scoped_user()
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "owner_id": 1,
            },
            headers=scoped_headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["owner_id"] == user.id

    def test_order_creation_persists_embedded_inventory_account(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "account": {
                    "game_account": "embedded-account",
                    "game_type": "王者荣耀",
                    "game_password": "secret",
                    "channel_region": "安卓一区",
                    "bound_phone": "13800000000",
                    "has_secondary": True,
                    "account_description": "订单内建档",
                    "account_images": ["data:image/png;base64,one"],
                    "note": "随订单创建",
                },
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        payload = response.json()
        account = seeded_db.get(Account, payload["account_id"])
        assert account is not None
        assert account.game_account == "embedded-account"
        assert account.business_mode == "SELF"
        assert account.inventory_type == "RECOVERY"
        assert account.account_description == "订单内建档"
        assert account.account_images == ["data:image/png;base64,one"]

    def test_dg_creation_returns_settlement_terms(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DG",
                "trade_date": D.isoformat(),
                "listing_price": "1200.00",
                "service_fee": "120.00",
                "commission_mode": "DEDUCT_FROM_SETTLEMENT",
                "commission_payer": "CONSIGNOR",
                "expected_settlement_date": "2026-10-20",
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        assert response.json()["listing_price"] == "1200.00"
        assert response.json()["service_fee"] == "120.00"
        assert response.json()["commission_mode"] == "DEDUCT_FROM_SETTLEMENT"
        assert response.json()["commission_payer"] == "CONSIGNOR"
        assert response.json()["expected_settlement_date"] == "2026-10-20"

    def test_dfq_composite_create_persists_buy_and_installment(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "initial_buy": {
                    "amount": "800.00",
                    "occurred_on": D.isoformat(),
                    "pool_id": 1,
                    "portion": "PRINCIPAL",
                },
                "installment": {
                    "contract_type": "ADVANCE_PURCHASE",
                    "principal": "800.00",
                    "down_payment": "0",
                    "service_fee": "80.00",
                    "periods": 2,
                    "per_period_service_fee": "40.00",
                    "per_period": "440.00",
                    "first_due_on": "2026-11-01",
                    "schedule": [
                        {"period_no": 1, "due_on": "2026-11-01"},
                        {"period_no": 2, "due_on": "2026-12-01"},
                    ],
                },
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        order_id = response.json()["id"]
        assert seeded_db.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order_id,
                OrderEvent.event_type == "BUY",
                OrderEvent.is_posted.is_(True),
            )
        ) is not None
        contract = seeded_db.scalar(
            select(Installment).where(Installment.order_id == order_id)
        )
        assert contract is not None
        assert contract.contract_type == "ADVANCE_PURCHASE"

    def test_embedded_installment_schedule_rejects_unknown_fields(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "installment": {
                    "contract_type": "ADVANCE_PURCHASE",
                    "principal": "800.00",
                    "periods": 1,
                    "first_due_on": "2026-11-01",
                    "schedule": [
                        {
                            "period_no": 1,
                            "due_on": "2026-11-01",
                            "unknown_field": "must be rejected",
                        }
                    ],
                },
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_dfq_composite_create_rolls_back_when_contract_is_invalid(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DFQ",
                "trade_date": D.isoformat(),
                "note": "atomic-dfq-failure",
                "initial_buy": {
                    "amount": "800.00",
                    "occurred_on": D.isoformat(),
                    "pool_id": 1,
                },
                "installment": {
                    "contract_type": "STOCK_SALE",
                    "principal": "800.00",
                    "periods": 1,
                    "first_due_on": "2026-11-01",
                },
            },
            headers=headers,
        )

        assert response.status_code == 422, response.text
        # 测试夹具将 get_db 替换为只 yield 会话，显式模拟生产依赖的异常回滚。
        seeded_db.rollback()
        assert seeded_db.scalar(
            select(Order.id).where(Order.note == "atomic-dfq-failure")
        ) is None
        assert seeded_db.scalar(
            select(OrderEvent.id).where(OrderEvent.note == "atomic-dfq-failure")
        ) is None

    def test_list_and_get_endpoints(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        listed = seeded_client.get(
            "/api/v1/orders", params={"order_type": "HS", "status": "ACTIVE"},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        assert [item["order_no"] for item in listed.json()] == [order.order_no]

        fetched = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
        assert fetched.status_code == 200
        assert fetched.json()["id"] == order.id
        assert len(fetched.json()["events"]) == 1
        assert fetched.json()["events"][0]["event_type"] == "BUY"
        assert fetched.json()["events"][0]["operator"] == "pytest"

        missing = seeded_client.get("/api/v1/orders/999999", headers=headers)
        assert missing.status_code == 404

    def test_order_detail_aggregates_finance_installment_and_audit(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        request_id = "order-detail-trace-20261017"
        record_audit(
            seeded_db,
            action=AuditAction.ORDER_CREATE,
            entity_type="order",
            entity_id=order.order_no,
            actor="pytest",
            request_id=request_id,
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="pytest",
        )
        rebate = finance_service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            rebate_type="BUY",
            base_amount="100.00",
            collected_on=D,
            actor="pytest",
        )
        installment = installments_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type="STOCK_SALE",
            principal="100.00",
            periods=1,
            per_period="100.00",
            first_due_on=D,
            actor="pytest",
        )

        response = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["cashflows"][0]["order_event_id"] is not None
        assert body["cashflows"][0]["flow_no"]
        assert body["rebates"][0]["id"] == rebate.id
        assert body["installment"]["id"] == installment.id
        assert len(body["installment_schedule"]) >= 1
        assert any(item["period_no"] == 1 for item in body["installment_schedule"])
        order_audit = next(
            item for item in body["audit"] if item["request_id"] == request_id
        )
        assert order_audit["request_id"] == request_id

    def test_order_link_endpoints_and_detail_links(self, seeded_client, seeded_db, headers):
        source = _order(seeded_db, order_type="DFQ")
        target = _order(seeded_db, order_type="HS")

        created = seeded_client.post(
            f"/api/v1/orders/{target.id}/links",
            json={
                "related_order_id": source.id,
                "relation_type": "SOURCE",
                "split_ratio": "50",
                "split_amount": "400",
                "note": "来源单",
            },
            headers=headers,
        )

        assert created.status_code == 201, created.text
        assert created.json()["source_order_no"] == source.order_no
        assert created.json()["direction"] == "SOURCE"
        listed = seeded_client.get(
            f"/api/v1/orders/{target.id}/links", headers=headers
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()[0]["target_order_no"] == target.order_no
        detail = seeded_client.get(f"/api/v1/orders/{target.id}", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["links"][0]["id"] == created.json()["id"]

    def test_pool_balance_endpoint_scope_forbidden(self, seeded_client, viewer_headers):
        # viewer 有 finance.read 但无池授权 → 越权池返回 404（不泄露存在性）
        response = seeded_client.get("/api/v1/pools/1/balance", headers=viewer_headers)
        assert response.status_code == 404

    def test_pool_balance_endpoint_ok(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/pools/1/balance", headers=headers)
        assert response.status_code == 200, response.text
        assert "available" in response.json()
