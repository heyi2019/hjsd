"""API-01 订单建单校验契约：从 TestCreateOrderValidation 拆出（34 tests）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    AccountStatus,
    CustomerStatus)
from app.business.inventory.profile import create_account
from app.customers.counterparties import create_counterparty
from app.customers.customers import create_customer, set_customer_status
from app.domain.trade import Account, Order
from app.domain.users import User
from app.settings.field_definitions.order_types import get_order_type_by_code, set_order_type_active
from app.business import schemas
from app.business.create import create_order
from app.business.events import post_event

D = date(2026, 10, 4)

def _order(
    seeded_db,
    *,
    order_type="HS",
    account_id=None,
    owner_id=None,
    trade_date=D,
    form_extra=None,
):
    if order_type == "HS" and account_id is None:
        account_id = create_account(
            seeded_db,
            game_account=f"orders-contract-{uuid4().hex[:10]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        ).id
    return create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
        form_extra=form_extra,
    )

def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )


class TestCreateOrderValidation:

    def test_order_owner_must_be_active(self, seeded_db):
        owner = seeded_db.get(User, 1)
        owner.is_active = False
        seeded_db.flush()

        with pytest.raises(Validation, match="订单负责人必须是启用用户"):
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                owner_id=owner.id,
                actor="pytest",
            )

    def test_installment_gate_flags_must_be_boolean_in_service(self, seeded_db):
        order = _order(seeded_db, order_type="HS")
        with pytest.raises(Validation, match="allow_installment_delivery 必须为布尔值"):
            post_event(
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

        account = create_account(
            seeded_db,
            game_account=f"finance-event-{uuid4().hex[:10]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order = create_order(
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
            f"/api/orders/{order.id}/events",
            headers=auth,
            json={"event_type": "BUY", "amount": "100", "occurred_on": D.isoformat(), "pool_id": 1},
        )
        assert buy.status_code == 201, buy.text

        sell = seeded_client.post(
            f"/api/orders/{order.id}/events",
            headers=auth,
            json={"event_type": "SELL", "amount": "120", "occurred_on": D.isoformat(), "pool_id": 1},
        )
        assert sell.status_code == 201, sell.text

    def test_order_api_rejects_removed_event(self, seeded_client, seeded_db, headers):
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="pytest",
        )
        seeded_db.commit()

        response = seeded_client.post(
            f"/api/orders/{order.id}/events",
            headers=headers,
            json={
                "event_type": "COST",
                "amount": "10",
                "occurred_on": D.isoformat(),
            },
        )

        assert response.status_code == 422, response.text
        assert "事件类型必须为" in response.json()["message"]

    def test_order_creation_validates_participants_before_creating_order(self, seeded_db):
        customer = create_customer(
            seeded_db, display_name="已停用客户", actor="pytest"
        )
        set_customer_status(
            seeded_db, customer.id, CustomerStatus.DISABLED.value, actor="pytest"
        )

        with pytest.raises(Validation, match="不可作为新订单参与方"):
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="operator",
                customer_roles=[(customer.id, "SELLER")],
                note="atomic-participant-validation",
            )

        seeded_db.commit()
        assert seeded_db.scalar(
            select(Order.id).where(Order.note == "atomic-participant-validation")
        ) is None

    def test_hs_buy_requires_inventory_account(self, seeded_db):
        order = create_order(
            seeded_db, order_type="HS", trade_date=D, actor="pytest"
        )

        with pytest.raises(Validation, match="库存账号"):
            post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
            )

    def test_unknown_order_type_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_order(
                seeded_db, order_type="ZZ", trade_date=D, actor="pytest"
            )
        assert "不存在" in str(exc.value)

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
            post_event(seeded_db, order.id, **kwargs)
        assert exc.value.details["field"] == field

    def test_duplicate_participant_role_rejected_before_unique_constraint(
        self, seeded_db
    ):
        customer = create_customer(
            seeded_db, display_name="重复角色客户", actor="pytest"
        )
        with pytest.raises(Validation, match="不可重复"):
            create_order(
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
        customer = create_customer(
            seeded_db, display_name="业务角色客户", actor="pytest"
        )
        supplier = create_counterparty(
            seeded_db, display_name="供货方", type="SUPPLIER", actor="pytest"
        )

        with pytest.raises(Validation, match="TH 不允许客户角色 SELLER"):
            create_order(
                seeded_db,
                order_type="TH",
                trade_date=D,
                actor="pytest",
                customer_roles=[(customer.id, "SELLER")],
            )

        with pytest.raises(Validation, match="TH 不允许合作方角色 SUPPLIER"):
            create_order(
                seeded_db,
                order_type="TH",
                trade_date=D,
                actor="pytest",
                counterparty_roles=[(supplier.id, "SUPPLIER")],
            )

    def test_participant_id_shape_is_rejected_before_database_flush(self, seeded_db):
        with pytest.raises(Validation, match="参与方 ID"):
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                customer_roles=[("not-an-id", "SELLER")],
            )

    def test_disabled_order_type_rejected(self, seeded_db):
        definition = get_order_type_by_code(seeded_db, "HS")
        set_order_type_active(
            seeded_db, definition.id, False, actor="pytest"
        )
        with pytest.raises(Validation) as exc:
            _order(seeded_db)
        assert "已停用" in str(exc.value)

    def test_order_rejects_mismatched_existing_account_context(self, seeded_db):
        account = Account(
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.WAITING.value,
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
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(Validation, match="库存账号业务类型与订单类型不匹配"):
            _order(seeded_db, order_type="HS", account_id=account.id)

    def test_order_create_rejects_operation_form_scope(self):
        with pytest.raises(ValidationError, match="extra_forbidden"):
            schemas.OrderCreate(
                order_type="DG",
                trade_date=D,
                form_extra_scope="CONSIGN",
            )

    def test_scoped_user_cannot_attach_foreign_account(self, seeded_db):
        account = Account(
            game_account="scope-account",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="another-operator",
            updated_by="another-operator",
        )
        seeded_db.add(account)
        seeded_db.flush()

        with pytest.raises(NotFound):
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="operator",
                account_id=account.id,
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_attach_foreign_customer(self, seeded_db):
        customer = create_customer(
            seeded_db,
            display_name="foreign-customer",
            actor="another-operator",
            owner_id=8,
        )

        with pytest.raises(NotFound):
            create_order(
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
        order = create_order(
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

    def test_th_links_pickup_inventory_account_without_snapshot(self, seeded_db):
        account = create_account(
            seeded_db,
            game_account="th-pickup-account",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            actor="pytest",
        )

        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=D,
            actor="pytest",
            account_id=account.id,
        )

        assert order.account_id == account.id
        assert order.account_snapshot is None

    def test_th_accepts_order_account_snapshot_and_creates_inline_account(self, seeded_db):
        """2026-10-28 口径：account_snapshot 四类业务通用，TH 快照建单即建号。"""
        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=D,
            actor="pytest",
            account_snapshot={"game_account": "th-snapshot-account"},
        )

        assert order.account_id is not None
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        assert account.game_account == "th-snapshot-account"
        assert account.stock_no is not None
        assert order.account_snapshot == {"game_account": "th-snapshot-account"}

    def test_account_snapshot_rejects_removed_legacy_account_fields(self, seeded_db):
        with pytest.raises(Validation, match="订单账号快照字段校验失败"):
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                account_snapshot={
                    "game_account": "hs-legacy-region",
                    "region": "旧字段",
                },
            )

    def test_account_snapshot_does_not_accept_inventory_media_fields(self, seeded_db):
        with pytest.raises(Validation, match="订单账号快照字段校验失败"):
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                account_snapshot={
                    "game_account": "hs-no-media",
                    "account_description": "订单快照不承载营销资料",
                    "account_images": ["image-1"],
                },
            )


