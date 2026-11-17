"""API-01 orders 订单/事件契约测试（ORD-01/02、FIN-01/03）。

与 test_orders.py / test_m2.py 的分工：既有文件已覆盖四类业务建单、
BUY/SELL/DELIVER/CANCEL/OPERATE(无 offset) 登记、状态机、路由缺失等主路径；
本文件补NotFound/越权/过滤/非法入参分支、`_opposite_direction` 三分支、
`_opposite_direction` 防御与 CANCEL 分支、以及 3 个未测路由端点。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, DEV_USERS, build_access_token
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CustomerStatus,
    OrderStatus,
)
from app.stocks.profile import create_account
from app.value_added_services import create as inst_create
from app.finance.rebates import create_rebate
from app.parties.counterparties import create_counterparty
from app.parties.customers import create_customer, set_customer_status
from app.domain.foundation import AuditLog
from app.domain.parties import OrderCustomerRole
from app.domain.trade import Account, Cashflow, Order, OrderEvent, OrderFormField, OrderLink
from app.domain.users import User
from app.foundation.order_types import get_order_type_by_code, set_order_type_active
from app.orders import schemas
from app.orders._shared import get_order
from app.orders.cancellation_model import cancel_order
from app.orders.create import create_order
from app.orders.events import _opposite_direction, post_event
from app.orders.links import create_order_link, delete_order_link, list_order_links
from app.orders.mutations import update_order
from app.finance.balances import pool_balance
from app.orders.queries import list_orders, order_customer_count
from app.orders.router_output import _order_list_payload

D = date(2026, 10, 4)

def test_order_create_uses_account_snapshot_as_the_only_account_input():
    with pytest.raises(ValidationError, match="extra_forbidden"):
        schemas.OrderCreate(
            order_type="HS",
            trade_date=D,
            game_account="legacy-flat-account",
        )


def test_workbench_summary_exposes_one_backend_aggregate(seeded_client, headers):
    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)

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
        "notifications",
        "reminders",
    }
    assert set(payload["period"]) == {"from", "to"}
    assert set(payload["notifications"]) == {"pending_profit_count", "allocated_profit_count"}
    assert seeded_client.get("/api/v1/stocks/dashboard-summary", headers=headers).status_code in {404, 405}
    assert seeded_client.get("/api/v1/notifications/summary", headers=headers).status_code in {404, 405}


def test_workbench_personal_earnings_uses_commission_profit_base(
    seeded_client, headers, monkeypatch
):
    monkeypatch.setattr(
        "app.workbench.service.r3_commission_reconciliation",
        lambda *args, **kwargs: {
            "order_groups": [],
            "total": {"order_count": 1, "profit_base": Decimal("123.45")},
        },
    )

    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["personal_earnings"] == "123.45"


def test_workbench_order_cards_use_the_current_period(seeded_client, headers, monkeypatch):
    calls = []

    def fake_order_status_counts(session, **kwargs):
        calls.append(kwargs)
        return {"COMPLETED": 1}

    monkeypatch.setattr("app.workbench.service.order_status_counts", fake_order_status_counts)

    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert len(calls) == 2
    today = date.today()
    expected = {"trade_date_from": today.replace(day=1), "trade_date_to": today}
    assert calls[0]["trade_date_from"] == expected["trade_date_from"]
    assert calls[0]["trade_date_to"] == expected["trade_date_to"]
    assert calls[0].get("mine", False) is False
    assert calls[1]["trade_date_from"] == expected["trade_date_from"]
    assert calls[1]["trade_date_to"] == expected["trade_date_to"]
    assert calls[1]["mine"] is True

def test_order_create_validates_active_custom_field_values(seeded_db):
    field = OrderFormField(
        order_type_code="HS",
        field_key="idcard_check",
        label="身份证",
        field_type="NUMBER",
        required=True,
        is_active=True,
        is_custom=True,
        section="ACCOUNT_PRODUCT",
        sort_order=1000,
    )
    seeded_db.add(field)
    seeded_db.flush()

    with pytest.raises(Validation, match="必须为数字"):
        create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="pytest",
            account_snapshot={"game_account": "invalid-extra-account"},
            form_extra={"idcard_check": "not-a-number"},
        )

def test_account_product_custom_values_follow_inline_inventory_account(seeded_db):
    field = OrderFormField(
        order_type_code="HS",
        field_key="idcard_store",
        label="身份证",
        field_type="TEXT",
        required=False,
        is_active=True,
        is_custom=True,
        section="ACCOUNT_PRODUCT",
        sort_order=1001,
    )
    seeded_db.add(field)
    seeded_db.flush()

    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot={
            "game_account": "account-extra-store",
            "extra_values": {"idcard_store": "123456"},
        },
        form_extra={"idcard_store": "123456"},
    )

    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    assert account.form_extra == {"idcard_store": "123456"}
    assert order.form_extra is None

@pytest.mark.parametrize(("order_type", "inventory_type"), [("HS", "RECOVERY"), ("TH", "PICKUP"), ("DG", "CONSIGNMENT")])
def test_inline_order_creates_inventory_in_one_request(seeded_client, seeded_db, headers, order_type, inventory_type):
    payload = {
        "order_type": order_type, "trade_date": D.isoformat(),
        "account_snapshot": {"game_account": f"inline-api-{order_type}"},
    }
    if order_type != "DG":
        payload["initial_buy"] = {"amount": "100", "occurred_on": D.isoformat()}
        payload["initial_costs"] = [{"amount": "10", "occurred_on": D.isoformat(), "flow_category": "FEE"}]
    response = seeded_client.post("/api/v1/orders", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    account = seeded_db.get(Account, response.json()["account_id"])
    assert account is not None
    assert account.inventory_type == inventory_type
    assert account.cost_amount == Decimal("110.00" if order_type != "DG" else "0.00")

    if order_type != "DG":
        order_id = response.json()["id"]
        assert not seeded_db.scalars(
            select(OrderEvent).where(
                OrderEvent.order_id == order_id,
                OrderEvent.event_type == "COST",
            )
        ).first()
        expense = seeded_db.scalars(
            select(Cashflow).where(
                Cashflow.order_id == order_id,
                Cashflow.category == "FEE",
            )
        ).first()
        assert expense is not None
        assert expense.direction == "OUT"
        assert expense.accounting_attribute in {"SELF_DIRECT_COST", "TH_DIRECT_COST"}
        list_row = _order_list_payload(seeded_db, [seeded_db.get(Order, order_id)])[0]
        assert list_row["cost_amount"] == Decimal("110.00")

def test_order_success_time_is_inventory_entry_time(seeded_db):
    account = create_account(
        seeded_db,
        game_account="inventory-entry-from-order",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    account.inventory_entry_at = datetime(2026, 1, 1, 8, 0)
    seeded_db.flush()

    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )

    assert account.inventory_entry_at == order.created_at.replace(microsecond=0)


def test_order_list_payload_includes_inventory_and_sale_responsibility_timestamps(seeded_db):
    order = _order(seeded_db)
    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    account.inventory_entry_at = datetime(2026, 10, 1, 9, 30, 0)
    account.created_by = "inventory-user"
    seeded_db.flush()

    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount="100.00",
        occurred_on=D,
        actor="inventory-user",
        pool_id=1,
    )
    sale, _ = post_event(
        seeded_db,
        order.id,
        event_type="SELL",
        amount="150.00",
        occurred_on=D,
        actor="sale-user",
        pool_id=2,
    )
    sale.created_at = datetime(2026, 10, 17, 16, 45, 0)
    seeded_db.flush()

    row = _order_list_payload(seeded_db, [order])[0]

    assert row["inventory_entry_at"] == datetime(2026, 10, 1, 9, 30, 0)
    assert row["inventory_operator"] is None
    # 售卖时间取卖出事件的业务发生日 D，与 created_at 无关（created_at 是写入时刻）。
    assert row["sale_at"] == datetime(2026, 10, 4, 0, 0, 0)
    assert row["sale_operator"] is None

def test_failed_initial_cost_rolls_back_order_and_inventory(app, seeded_db, v1_engine, headers, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker
    from app.core import database

    monkeypatch.setattr(database, "get_session_factory", lambda: sessionmaker(bind=v1_engine))
    with TestClient(app) as client:
        response = client.post("/api/v1/orders", headers=headers, json={
            "order_type": "HS", "trade_date": D.isoformat(),
            "account_snapshot": {"game_account": "rollback-inline"},
            "initial_buy": {"amount": "100", "occurred_on": D.isoformat()},
            "initial_costs": [{"amount": "0", "occurred_on": D.isoformat()}],
        })
    assert response.status_code == 422, response.text
    assert seeded_db.scalar(select(Account).where(Account.game_account == "rollback-inline")) is None
    assert seeded_db.scalar(
        select(Order).where(
            # 跨方言 JSON 取值：func.json_extract 是 SQLite 专有函数，PG 无此函数。
            Order.account_snapshot["game_account"].as_string() == "rollback-inline"
        )
    ) is None

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

def test_database_allows_inventory_links_for_th_orders(seeded_db):
    account = create_account(
        seeded_db,
        game_account="th-inventory-link",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
        actor="pytest",
    )
    order = _order(seeded_db, order_type="TH", account_id=account.id)

    seeded_db.flush()
    assert order.account_id == account.id
    assert order.account_snapshot is None

def test_database_accepts_th_order_snapshot_and_rejects_custom_type(seeded_db):
    """2026-10-28 口径：快照 CHECK 放宽为四类业务通用，自定义类型仍被库层拒绝。"""
    order = _order(seeded_db, order_type="TH")
    order.account_snapshot = {"game_account": "th-text-only"}
    seeded_db.flush()
    assert order.account_snapshot == {"game_account": "th-text-only"}
    seeded_db.rollback()

    custom = Order(order_no=f"XX{uuid4().hex[:8]}", order_type="XX", trade_date=D)
    custom.account_snapshot = {"game_account": "custom-text"}
    seeded_db.add(custom)
    with pytest.raises(IntegrityError):
        seeded_db.flush()
    seeded_db.rollback()

@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_sell_completes_non_installment_orders(seeded_db, order_type):
    inventory_context = {
        "HS": ("SELF", "RECOVERY"),
        "TH": ("DISTRIBUTION", "PICKUP"),
        "DG": ("DISTRIBUTION", "CONSIGNMENT"),
    }[order_type]
    account = create_account(
        seeded_db,
        game_account=f"sell-completes-{order_type.lower()}-{uuid4().hex[:10]}",
        business_mode=inventory_context[0],
        inventory_type=inventory_context[1],
        actor="pytest",
    )
    order = _order(seeded_db, order_type=order_type, account_id=account.id)

    if order_type in {"HS", "TH"}:
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=D,
            actor="pytest",
            pool_id=1,
        )

    post_event(
        seeded_db,
        order.id,
        event_type="SELL",
        amount=Decimal("150"),
        occurred_on=D,
        actor="pytest",
        pool_id=2,
    )

    assert order.status == OrderStatus.COMPLETED.value

# ------------------------------------------------------------------ 建单校验
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

    def test_order_links_record_source_follow_up_and_split_share(self, seeded_db):
        source = _order(seeded_db, order_type="HS")
        follow_up = _order(seeded_db, order_type="HS")

        link = create_order_link(
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
        listed = list_order_links(seeded_db, follow_up.id)
        assert listed[0]["direction"] == "SOURCE"
        assert listed[0]["source_order_no"] == source.order_no
        assert listed[0]["split_ratio"] == Decimal("50.00")

        with pytest.raises(Validation, match="订单关联已存在"):
            create_order_link(
                seeded_db,
                source.id,
                related_order_id=follow_up.id,
                relation_type="FOLLOW_UP",
                actor="pytest",
            )

    def test_order_link_rejects_self_and_invalid_relation(self, seeded_db):
        order = _order(seeded_db, order_type="HS")
        with pytest.raises(Validation, match="不能关联自身"):
            create_order_link(
                seeded_db,
                order.id,
                related_order_id=order.id,
                relation_type="SOURCE",
                actor="pytest",
            )
        with pytest.raises(Validation, match="关联方向无效"):
            create_order_link(
                seeded_db,
                order.id,
                related_order_id=999999,
                relation_type="UNKNOWN",
                actor="pytest",
            )

    def test_order_link_delete_removes_link_and_writes_audit(self, seeded_db):
        source = _order(seeded_db, order_type="HS")
        follow_up = _order(seeded_db, order_type="HS")
        link = create_order_link(
            seeded_db,
            follow_up.id,
            related_order_id=source.id,
            relation_type="SOURCE",
            split_ratio=Decimal("50"),
            split_amount=Decimal("400"),
            note="来源订单",
            actor="pytest",
        )

        delete_order_link(seeded_db, follow_up.id, link.id, actor="pytest")

        assert seeded_db.scalar(select(OrderLink).where(OrderLink.id == link.id)) is None
        assert list_order_links(seeded_db, follow_up.id) == []
        assert list_order_links(seeded_db, source.id) == []
        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.ORDER_LINK_DELETE.value,
                AuditLog.entity_id == str(link.id),
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.before_json["relation_type"] == "SOURCE"
        assert audit.before_json["split_amount"] == "400.00"
        # 删除后同一对订单可重新建立关联（唯一约束不阻挡重建）。
        # 注意：SQLite rowid 是 max+1 复用语义（AUTOINCREMENT 关键字未生成），
        # 删掉最大行后重建可能拿回同一 id —— 这是 DB 固有语义，不是缺陷。
        again = create_order_link(
            seeded_db,
            follow_up.id,
            related_order_id=source.id,
            relation_type="SOURCE",
            actor="pytest",
        )
        assert again.id is not None
        relisted = list_order_links(seeded_db, follow_up.id)
        assert [item["id"] for item in relisted] == [again.id]

    def test_order_link_delete_rejects_foreign_and_missing(self, seeded_db):
        source = _order(seeded_db, order_type="HS")
        follow_up = _order(seeded_db, order_type="HS")
        bystander = _order(seeded_db, order_type="HS")
        link = create_order_link(
            seeded_db,
            follow_up.id,
            related_order_id=source.id,
            relation_type="SOURCE",
            actor="pytest",
        )
        # 无关订单视角删除 → 404（不泄露关联存在性）
        with pytest.raises(NotFound, match="不存在"):
            delete_order_link(seeded_db, bystander.id, link.id, actor="pytest")
        assert seeded_db.scalar(select(OrderLink).where(OrderLink.id == link.id)) is not None
        # 对端（source 方）视角允许删除
        delete_order_link(seeded_db, source.id, link.id, actor="pytest")
        assert seeded_db.scalar(select(OrderLink).where(OrderLink.id == link.id)) is None
        # 重复删除 → 404
        with pytest.raises(NotFound, match="不存在"):
            delete_order_link(seeded_db, follow_up.id, link.id, actor="pytest")

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

    def test_order_api_rejects_removed_event(self, seeded_client, seeded_db, headers):
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="pytest",
        )
        seeded_db.commit()

        response = seeded_client.post(
            f"/api/v1/orders/{order.id}/events",
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

    def test_dg_service_accepts_commission_terms(self, seeded_db):
        """佣金口径只属于 DG 代挂单：支付方式与承担方成对落库（DB CHECK 同口径）。

        入参小写也要归一成大写，否则会被 `order_commission_mode_valid` 拒绝。
        """
        order = create_order(
            seeded_db,
            order_type="DG",
            trade_date=D,
            actor="pytest",
            commission_mode="deduct_from_settlement",
            commission_payer="consignor",
        )
        assert (order.commission_mode, order.commission_payer) == (
            "DEDUCT_FROM_SETTLEMENT",
            "CONSIGNOR",
        )

    def test_commission_terms_reject_incomplete_pair(self, seeded_db):
        with pytest.raises(Validation, match="同时填写或同时留空"):
            create_order(
                seeded_db,
                order_type="DG",
                trade_date=D,
                actor="pytest",
                commission_mode="SEPARATE_PAYMENT",
            )

    def test_commission_terms_reject_unknown_value(self, seeded_db):
        with pytest.raises(Validation, match="commission_mode"):
            create_order(
                seeded_db,
                order_type="DG",
                trade_date=D,
                actor="pytest",
                commission_mode="WHATEVER",
                commission_payer="BUYER",
            )

    def test_commission_terms_reject_non_dg_order_type(self, seeded_db):
        with pytest.raises(Validation, match="只有 DG 代挂订单"):
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=D,
                actor="pytest",
                commission_mode="SEPARATE_PAYMENT",
                commission_payer="BUYER",
            )

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

# ------------------------------------------------------------------ 查询与作用域
class TestGetAndListOrders:
    def test_get_order_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            get_order(seeded_db, 999999)

    def test_active_order_can_update_note_before_posting(self, seeded_db):
        order = _order(seeded_db)
        updated = update_order(
            seeded_db, order.id, actor="operator", note="补充客户备注"
        )
        assert updated.note == "补充客户备注"

    def test_order_trade_date_cannot_be_cleared(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="订单日期不能清空"):
            update_order(
                seeded_db, order.id, actor="operator", trade_date=None
            )

    def test_posted_order_can_shift_trade_date_and_accounting_dates(self, seeded_db):
        """成交日期放开后：有登记事件的订单也能改日期，事件/资金流水按天数差平移。"""
        order = _order(seeded_db, order_type="DG")
        post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("200"),
            occurred_on=D,
            actor="pytest",
            portion="GROSS",
        )
        # 补一条「成交日后第 2 天」的事件，验证平移保留相对时间关系而非统一改日期。
        seeded_db.add(OrderEvent(
            order_id=order.id,
            event_type="DELIVER",
            event_no="EV-SHIFT-01",
            is_posted=False,
            amount=Decimal("0"),
            portion="PRINCIPAL",
            occurred_on=D + timedelta(days=2),
            created_by="pytest",
            updated_by="pytest",
        ))
        seeded_db.flush()
        new_date = D + timedelta(days=5)

        updated = update_order(
            seeded_db, order.id, actor="operator", trade_date=new_date
        )
        assert updated.trade_date == new_date
        events = list(seeded_db.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all())
        shifted = {e.event_no: e.occurred_on for e in events}
        assert shifted["EV-SHIFT-01"] == D + timedelta(days=7)
        assert all(value in {new_date, D + timedelta(days=7)} for value in shifted.values())
        flows = list(seeded_db.scalars(
            select(Cashflow).where(Cashflow.order_id == order.id)
        ).all())
        assert flows, "SELL 事件应派生资金流水，用于验证账期联动"
        assert all(f.occurred_on == new_date for f in flows)

        # 只改备注不传日期时不触发平移，日期保持新值。
        unchanged = update_order(
            seeded_db, order.id, actor="operator", note="仅改备注"
        )
        assert unchanged.note == "仅改备注"
        assert unchanged.trade_date == new_date

    def test_order_cancel_requires_no_posted_events(self, seeded_db):
        order = _order(seeded_db)
        cancelled = cancel_order(
            seeded_db, order.id, actor="operator", reason="客户撤单"
        )
        assert cancelled.status == "CANCELLED"

        posted = _order(seeded_db)
        post_event(
            seeded_db, posted.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=D, actor="pytest"
        )
        with pytest.raises(Validation, match="登记事件"):
            cancel_order(
                seeded_db, posted.id, actor="operator", reason="不能直接取消"
            )

    def test_system_offsale_cancels_dg_order_and_removes_account_from_inventory(self, seeded_db):
        order = create_order(
            seeded_db,
            order_type="DG",
            trade_date=D,
            actor="pytest",
            account_snapshot={"game_account": "system-offsale-dg"},
        )
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        assert account.status == AccountStatus.WAITING.value

        cancelled = cancel_order(
            seeded_db,
            order.id,
            actor="operator",
            reason="代挂结束",
            form_extra_scope="INVOID",
            form_extra={"platform_unlist_scope": "SYSTEM"},
        )

        assert cancelled.status == OrderStatus.CANCELLED.value
        assert account.status == AccountStatus.VOID.value

    def test_get_order_owner_scope_forbidden(self, seeded_db):
        # 他人 owner 的订单对 SELF 作用域用户同样 404（不泄露存在性）
        order = _order(seeded_db, owner_id=1)
        with pytest.raises(NotFound):
            get_order(seeded_db, order.id, _scoped_user())

    def test_scoped_user_cannot_post_event_to_foreign_order(self, seeded_db):
        order = _order(seeded_db, owner_id=1)
        with pytest.raises(NotFound):
            post_event(
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
            post_event(
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
        post_event(
            seeded_db, mine.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )

        by_type = list_orders(seeded_db, order_type="HS")
        assert [o.id for o in by_type] == [mine.id]
        by_status = list_orders(seeded_db, status="ACTIVE")
        assert mine.id in [o.id for o in by_status]  # 创建即 ACTIVE，登记不翻转状态

        scoped = list_orders(seeded_db, user=_scoped_user())
        assert [o.id for o in scoped] == [mine.id]
        # 无 user 不过滤：两张单都可见
        assert len(list_orders(seeded_db)) == 2

    def test_list_orders_filters_by_inventory_and_sale_operators(self, seeded_db):
        users = list(seeded_db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).all())
        inventory_hit = _order(seeded_db, form_extra={"business_responsible_ids": [users[0].id]})
        inventory_miss = _order(seeded_db, form_extra={"business_responsible_ids": [users[1].id]})
        sale_hit = _order(seeded_db)
        sale_miss = _order(seeded_db)
        post_event(seeded_db, sale_hit.id, event_type="BUY", amount="80.00", occurred_on=D, actor="pytest")
        post_event(seeded_db, sale_hit.id, event_type="SELL", amount="100.00", occurred_on=D, actor="pytest", operator_user_ids=[users[0].id])
        post_event(seeded_db, sale_miss.id, event_type="BUY", amount="80.00", occurred_on=D, actor="pytest")
        post_event(seeded_db, sale_miss.id, event_type="SELL", amount="100.00", occurred_on=D, actor="pytest", operator_user_ids=[users[1].id])

        assert {order.id for order in list_orders(seeded_db, inventory_operator_ids=[users[0].id])} == {inventory_hit.id}
        assert {order.id for order in list_orders(seeded_db, sale_operator_ids=[users[0].id])} == {sale_hit.id}
        assert inventory_miss.id not in {order.id for order in list_orders(seeded_db, inventory_operator_ids=[users[0].id])}

    def test_list_orders_mine_uses_inventory_or_sale_operator(self, seeded_db):
        users = list(seeded_db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).all())
        inventory_by_me = _order(seeded_db, form_extra={"business_responsible_ids": [users[0].id]})
        sold_by_me = _order(seeded_db)
        post_event(
            seeded_db, sold_by_me.id, event_type="BUY", amount="50.00",
            occurred_on=D, actor="pytest",
        )
        post_event(
            seeded_db, sold_by_me.id, event_type="SELL", amount="100.00",
            occurred_on=D, actor="operator", operator_user_ids=[users[0].id],
        )
        both_by_me = _order(seeded_db, form_extra={"business_responsible_ids": [users[0].id]})
        post_event(
            seeded_db, both_by_me.id, event_type="BUY", amount="50.00",
            occurred_on=D, actor="pytest",
        )
        post_event(
            seeded_db, both_by_me.id, event_type="SELL", amount="100.00",
            occurred_on=D, actor="operator", operator_user_ids=[users[0].id],
        )
        foreign = _order(seeded_db, owner_id=users[0].id)

        operator = CurrentUser.build(
            id=users[0].id, username=users[0].username, roles=["ADMIN"], owner_scope="ALL"
        )
        personal = list_orders(seeded_db, user=operator, mine=True)
        personal_ids = {order.id for order in personal}
        assert {inventory_by_me.id, sold_by_me.id, both_by_me.id}.issubset(personal_ids)
        assert foreign.id not in personal_ids

    def test_list_orders_mine_ignores_non_inventory_and_non_sale_operators(self, seeded_db):
        """我的订单只认入库和售出两个操作人，不把其他事件参与人算进来。"""
        users = list(
            seeded_db.scalars(
                select(User).where(User.is_active.is_(True)).order_by(User.id)
            ).all()
        )
        me, other = users[0], users[1]

        buy_by_me = _order(seeded_db, owner_id=other.id)
        post_event(
            seeded_db, buy_by_me.id, event_type="BUY", amount="80.00",
            occurred_on=D, actor=me.username,
        )
        assigned_as_operator = _order(seeded_db, owner_id=other.id)
        post_event(
            seeded_db, assigned_as_operator.id, event_type="BUY", amount="90.00",
            occurred_on=D, actor="pytest", operator_user_ids=[me.id],
        )
        foreign = _order(seeded_db, owner_id=other.id)
        post_event(
            seeded_db, foreign.id, event_type="BUY", amount="70.00",
            occurred_on=D, actor="pytest",
        )
        inventory_by_me = _order(seeded_db, owner_id=other.id, form_extra={"business_responsible_ids": [me.id]})

        operator = CurrentUser.build(
            id=me.id, username=me.username, roles=["OPERATOR"], owner_scope="ALL"
        )
        personal_ids = {
            order.id for order in list_orders(seeded_db, user=operator, mine=True)
        }
        assert buy_by_me.id not in personal_ids
        assert assigned_as_operator.id not in personal_ids
        assert inventory_by_me.id in personal_ids
        assert foreign.id not in personal_ids

    def test_order_customer_count_deduplicates_customers_for_mine_orders(self, seeded_db):
        users = list(seeded_db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).all())
        customer_a = create_customer(seeded_db, display_name="客户A", actor=users[0].username)
        customer_b = create_customer(seeded_db, display_name="客户B", actor=users[0].username)
        first = _order(seeded_db, form_extra={"business_responsible_ids": [users[0].id]})
        second = _order(seeded_db, form_extra={"business_responsible_ids": [users[0].id]})
        for order in (first, second):
            seeded_db.add(OrderCustomerRole(order_id=order.id, customer_id=customer_a.id, role="BUYER"))
        seeded_db.add(OrderCustomerRole(order_id=second.id, customer_id=customer_b.id, role="BUYER"))
        seeded_db.flush()
        operator = CurrentUser.build(id=users[0].id, username=users[0].username, roles=["ADMIN"], owner_scope="ALL")
        assert order_customer_count(seeded_db, user=operator, mine=True) == 2

    def test_list_orders_supports_workbench_date_owner_keyword_filters(
        self, seeded_client, seeded_db, headers
    ):
        mine = _order(seeded_db, owner_id=9, trade_date=date(2026, 10, 3))
        # 2026-10-28 去冗余：订单侧账号关键词走 account_snapshot JSON 检索
        mine.account_snapshot = {"game_account": "workbench-keyword-account"}
        _order(seeded_db, order_type="TH", owner_id=1, trade_date=date(2026, 10, 4))
        seeded_db.flush()

        response = seeded_client.get(
            "/api/v1/orders",
            params={
                "trade_date_from": "2026-10-03",
                "trade_date_to": "2026-10-03",
                "owner_id": 9,
                "keyword": "workbench-keyword",
                "limit": 10,
                "offset": 0,
            },
            headers=headers,
        )

        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        assert [item["id"] for item in response.json()["items"]] == [mine.id]

    def test_order_keyword_search_treats_underscore_literally(
        self, seeded_client, seeded_db, headers
    ):
        """账号含下划线时按字面匹配，不把 `_` 当单字符通配误匹配其它账号。"""
        hit = _order(seeded_db, order_type="TH", owner_id=9)
        hit.account_snapshot = {"game_account": "abc_123"}
        decoy = _order(seeded_db, order_type="TH", owner_id=9)
        decoy.account_snapshot = {"game_account": "abcX123"}  # `_` 若未转义会命中此行
        seeded_db.flush()

        response = seeded_client.get(
            "/api/v1/orders",
            params={"keyword": "abc_123", "limit": 10, "offset": 0},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        assert [item["id"] for item in response.json()["items"]] == [hit.id]

    def test_order_keyword_search_treats_percent_literally(
        self, seeded_client, seeded_db, headers
    ):
        """`%` 按字面匹配，不能把关键词里的 % 变成全量通配。"""
        hit = _order(seeded_db, order_type="TH", owner_id=9)
        hit.account_snapshot = {"game_account": "50%off"}
        decoy = _order(seeded_db, order_type="TH", owner_id=9)
        decoy.account_snapshot = {"game_account": "anything-else"}
        seeded_db.flush()

        response = seeded_client.get(
            "/api/v1/orders",
            params={"keyword": "50%", "limit": 10, "offset": 0},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        assert [item["id"] for item in response.json()["items"]] == [hit.id]

# ------------------------------------------------------------------ 事件入参
class TestPostEventValidation:
    def test_invalid_portion_rejected_before_event_write(self, seeded_db):
        order = _order(seeded_db)

        with pytest.raises(Validation, match="portion"):
            post_event(
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

    def test_invalid_event_type_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            post_event(
                seeded_db, order.id, event_type="BOGUS", amount="1.00",
                occurred_on=D, actor="pytest",
            )
        assert "事件类型" in str(exc.value)

    def test_transfer_removed_from_event_types(self, seeded_db):
        """划转已从 EventType 移除：不再是「可枚举但不可登记」，而是非法事件类型。"""
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            post_event(
                seeded_db, order.id, event_type="TRANSFER", amount="1.00",
                occurred_on=D, actor="pytest",
            )
        assert "事件类型" in str(exc.value)

    def test_deliver_requires_note(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            post_event(
                seeded_db, order.id, event_type="DELIVER",
                occurred_on=D, actor="pytest", delivery_mode="CUSTOMER_SELF",
            )
        assert "凭证" in str(exc.value)
        with pytest.raises(Validation, match="凭证"):
            post_event(
                seeded_db, order.id, event_type="DELIVER",
                occurred_on=D, actor="pytest", delivery_mode="CUSTOMER_SELF",
                note=123,
            )

    def test_post_event_to_inactive_pool_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(NotFound):
            post_event(
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
        buy_a, _ = post_event(
            seeded_db, order_a.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        cancel_a, _ = post_event(
            seeded_db, order_a.id, event_type="CANCEL", amount="100.00",
            occurred_on=D, actor="pytest", offset_event_id=buy_a.id,
            reason="撤回全部买入款",
        )
        assert order_a.status == "CANCELLED"

        # 分支二：offset 指向 SELL → 方向取反为 OUT
        order_b = _order(seeded_db, order_type="TH")
        buy_event, _ = post_event(
            seeded_db, order_b.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        sell_event, _ = post_event(
            seeded_db, order_b.id, event_type="SELL", amount="150.00",
            occurred_on=D, actor="pytest", offset_event_id=buy_event.id,
        )
        cancel_b, _ = post_event(
            seeded_db, order_b.id, event_type="CANCEL", amount="10.00",
            occurred_on=D, actor="pytest", offset_event_id=sell_event.id,
            reason="买家部分退款",
        )

        # 分支三：offset 指向不存在的事件 → NotFound。FK 全局强制使经 post_event
        # 不可达（INSERT order_events 即失败，校验在 flush 之后），直调私有函数覆盖
        with pytest.raises(NotFound):
            _opposite_direction(999999, seeded_db)

        flows = {
            row.id: row
            for row in seeded_db.scalars(select(Cashflow)).all()
        }
        assert flows[cancel_a.id].direction == Direction.IN.value
        assert flows[cancel_b.id].direction == Direction.OUT.value

    def test_cancel_requires_reason_and_th_offset(self, seeded_db):
        hs = _order(seeded_db)
        _hs_buy, _ = post_event(
            seeded_db, hs.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_reason:
            post_event(
                seeded_db, hs.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest",
            )
        assert "原因" in str(missing_reason.value)

        with pytest.raises(Validation, match="offset_event_id"):
            post_event(
                seeded_db, hs.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason="回收退回",
            )

        th = _order(seeded_db, order_type="TH")
        post_event(
            seeded_db, th.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation) as missing_offset:
            post_event(
                seeded_db, th.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason="同行未付成功",
            )
        assert "offset_event_id" in str(missing_offset.value)

    def test_cancel_reasons_require_text_values(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="取消必须填写原因"):
            cancel_order(
                seeded_db, order.id, actor="pytest", reason=123
            )

        post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        with pytest.raises(Validation, match="CANCEL 必须填写冲销原因"):
            post_event(
                seeded_db, order.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", reason=123,
            )

    def test_cancel_cannot_exceed_offset_remaining_or_change_pool(self, seeded_db):
        order = _order(seeded_db, order_type="TH")
        buy, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest", pool_id=1,
        )

        with pytest.raises(Validation) as wrong_pool:
            post_event(
                seeded_db, order.id, event_type="CANCEL", amount="10.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                pool_id=2, reason="资金账户更正",
            )
        assert "资金账户" in str(wrong_pool.value)

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="60.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退款",
        )
        assert order.status == OrderStatus.ACTIVE.value
        with pytest.raises(Validation) as over_cancel:
            post_event(
                seeded_db, order.id, event_type="CANCEL", amount="50.00",
                occurred_on=D, actor="pytest", offset_event_id=buy.id,
                reason="再次退款",
            )
        assert "剩余可冲销" in str(over_cancel.value)

    def test_cancel_offset_must_belong_to_the_same_order(self, seeded_db):
        first = _order(seeded_db)
        second = _order(seeded_db, order_type="TH")
        buy_event, _ = post_event(
            seeded_db,
            second.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="pytest",
        )
        order_event, _ = post_event(
            seeded_db,
            second.id,
            event_type="SELL",
            amount="150.00",
            occurred_on=D,
            actor="pytest",
            offset_event_id=buy_event.id,
        )

        with pytest.raises(Validation) as exc:
            post_event(
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

# ------------------------------------------------------------------ 账号效果
class TestAccountEffect:
    def test_event_updates_account_operator(self, seeded_db):
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
        order = _order(seeded_db, account_id=account.id)

        post_event(
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
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        buy, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        assert account.cost_amount == 500
        assert account.status == AccountStatus.WAITING.value

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="500.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="回收退回",
        )
        assert account.cost_amount == 0
        assert account.status == AccountStatus.VOID.value

    def test_partial_buy_cancel_keeps_account_in_stock(self, seeded_db):
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
        order = _order(seeded_db, account_id=account.id)
        buy, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="100.00",
            occurred_on=D, actor="pytest", offset_event_id=buy.id,
            reason="部分退回",
        )

        assert account.cost_amount == Decimal("400.00")
        assert account.status == AccountStatus.WAITING.value

    def test_cancel_sell_restores_stock_without_reducing_cost(self, seeded_db):
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
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        sell, _ = post_event(
            seeded_db, order.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="pytest",
        )
        assert account.status == AccountStatus.SOLD.value

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="800.00",
            occurred_on=D, actor="pytest", offset_event_id=sell.id,
            reason="售出撤销",
        )

        assert account.cost_amount == Decimal("500.00")
        assert account.status == AccountStatus.WAITING.value

    def test_cancel_pickup_sell_ends_without_returning_to_inventory(self, seeded_db):
        account = Account(
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            status=AccountStatus.WAITING.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, order_type="TH", account_id=account.id)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1.00",
            occurred_on=D, actor="pytest", pool_id=1,
        )
        sell, _ = post_event(
            seeded_db, order.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="pytest", pool_id=2,
        )

        post_event(
            seeded_db, order.id, event_type="CANCEL", amount="800.00",
            occurred_on=D, actor="pytest", offset_event_id=sell.id,
            reason="提号售出撤销",
        )

        assert account.status == AccountStatus.VOID.value

    def test_removed_payment_event_is_rejected(self, seeded_db):
        order = _order(seeded_db, order_type="TH")
        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="PAYMENT",
                amount=Decimal("100"),
                occurred_on=D,
                actor="pytest",
            )

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
            pool_balance(seeded_db, 2, user=scoped)

    def test_pool_balance_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            pool_balance(seeded_db, 999999)

# ------------------------------------------------------------------ 路由层
class TestOrdersApi:

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

    def test_th_account_snapshot_creates_inline_account_via_api(
        self, seeded_client, headers
    ):
        """2026-10-28 口径：TH 快照建单即建号（API 契约层）。"""
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "TH",
                "trade_date": D.isoformat(),
                "account_snapshot": {"game_account": "th-snapshot-api"},
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["account_id"] is not None
        assert body["account_snapshot"] == {"game_account": "th-snapshot-api"}

    def test_th_snapshot_with_flat_fields_rejected_by_api(
        self, seeded_client, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "TH",
                "trade_date": D.isoformat(),
                "account_snapshot": {"game_account": "th-snapshot-api"},
                "game_account": "th-flat-api",
            },
            headers=headers,
        )
        assert created.status_code == 422, created.text
        assert any(
            error["field"] == "game_account"
            for error in created.json()["details"]["errors"]
        )

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

    def test_admin_created_order_defaults_owner_to_operator(self, seeded_client, headers):
        """未指定负责人时兜底为操作人本人：owner_id 落 NULL 会让单据在按归属过滤后
        对 SELF 用户永久不可见（历史 153 单曾因此全为 NULL）。"""
        response = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "HS", "trade_date": D.isoformat()},
            headers=headers,
        )

        assert response.status_code == 201, response.text
        assert response.json()["owner_id"] == DEV_USERS["admin"].id

    def test_dg_creation_rejects_legacy_settlement_terms(
        self, seeded_client, seeded_db, headers
    ):
        # 佣金口径已在建单接口打通，这里只保留「旧结算字段被拒」的断言。
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DG",
                "trade_date": D.isoformat(),
                "listing_price": "1200.00",
                "service_fee": "120.00",
                "expected_settlement_date": "2026-10-20",
            },
            headers=headers,
        )

        assert response.status_code == 422, response.text
        assert "Extra inputs are not permitted" in response.text

    def test_dg_creation_persists_commission_terms(
        self, seeded_client, seeded_db, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DG",
                "trade_date": D.isoformat(),
                "commission_mode": "DEDUCT_FROM_SETTLEMENT",
                "commission_payer": "CONSIGNOR",
            },
            headers=headers,
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["commission_mode"] == "DEDUCT_FROM_SETTLEMENT"
        assert body["commission_payer"] == "CONSIGNOR"

    def test_embedded_installment_schedule_rejects_unknown_fields(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "TH",
                "trade_date": D.isoformat(),
                "installment": {
                    "contract_type": "PICKUP_SALE",
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

    def test_list_and_get_endpoints(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        listed = seeded_client.get(
            "/api/v1/orders", params={"order_type": "HS", "status": "ACTIVE"},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        assert [item["order_no"] for item in listed.json()["items"]] == [order.order_no]

        fetched = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
        assert fetched.status_code == 200
        assert fetched.json()["id"] == order.id
        assert len(fetched.json()["events"]) == 1
        assert fetched.json()["events"][0]["event_type"] == "BUY"
        assert fetched.json()["events"][0]["operator"] == "-"

        missing = seeded_client.get("/api/v1/orders/999999", headers=headers)
        assert missing.status_code == 404

    def test_detail_operator_uses_selected_employee_not_audit_actor(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="login-auditor",
            operator_user_ids=[9],
        )

        fetched = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["events"][0]["operator"] == "种子用户9"
        assert fetched.json()["cashflows"][0]["operator"] == "种子用户9"

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
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="pytest",
        )
        rebate = create_rebate(
            seeded_db,
            source_order_id=order.id,
            rebate_type="BUY",
            amount="100.00",
            collected_on=D,
            actor="pytest",
        )
        installment = inst_create.create_installment(
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
        assert body["cashflows"][0]["source_type"] == "ORDER_EVENT"
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
        source = _order(seeded_db, order_type="HS")
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

    def test_order_link_delete_endpoint(self, seeded_client, seeded_db, headers):
        source = _order(seeded_db, order_type="HS")
        target = _order(seeded_db, order_type="HS")
        created = seeded_client.post(
            f"/api/v1/orders/{target.id}/links",
            json={
                "related_order_id": source.id,
                "relation_type": "SOURCE",
                "note": "来源单",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        link_id = created.json()["id"]

        deleted = seeded_client.delete(
            f"/api/v1/orders/{target.id}/links/{link_id}", headers=headers
        )
        assert deleted.status_code == 204, deleted.text
        listed = seeded_client.get(
            f"/api/v1/orders/{target.id}/links", headers=headers
        )
        assert listed.status_code == 200, listed.text
        assert listed.json() == []
        detail = seeded_client.get(f"/api/v1/orders/{target.id}", headers=headers)
        assert detail.json()["links"] == []

        # 重复删除 → 404
        again = seeded_client.delete(
            f"/api/v1/orders/{target.id}/links/{link_id}", headers=headers
        )
        assert again.status_code == 404, again.text

    def test_order_link_delete_requires_update_permission(self, seeded_client, seeded_db, headers, viewer_headers):
        source = _order(seeded_db, order_type="HS")
        target = _order(seeded_db, order_type="HS")
        created = seeded_client.post(
            f"/api/v1/orders/{target.id}/links",
            json={"related_order_id": source.id, "relation_type": "SOURCE"},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        response = seeded_client.delete(
            f"/api/v1/orders/{target.id}/links/{created.json()['id']}",
            headers=viewer_headers,
        )
        assert response.status_code == 403, response.text

    def test_pool_balance_endpoint_scope_forbidden(self, seeded_client, viewer_headers):
        # viewer 有 finance.read 但无池授权 → 越权池返回 404（不泄露存在性）
        response = seeded_client.get("/api/v1/pools/1/balance", headers=viewer_headers)
        assert response.status_code == 404

    def test_pool_balance_endpoint_ok(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/pools/1/balance", headers=headers)
        assert response.status_code == 200, response.text
        assert "available" in response.json()
