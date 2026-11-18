"""API-01 订单查询/事件校验契约：TestGetAndListOrders + TestPostEventValidation。"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.shared.audit import record_audit
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
from app.installments import create as inst_create
from app.finance.rebates import create_rebate
from app.customer_center.counterparties import create_counterparty
from app.customer_center.customers import create_customer, set_customer_status
from app.domain.foundation import AuditLog
from app.domain.parties import OrderCustomerRole
from app.domain.trade import Account, Cashflow, Order, OrderEvent, OrderFormField
from app.domain.users import User
from app.field_definitions.order_types import get_order_type_by_code, set_order_type_active
from app.orders import schemas
from app.shared.order_access import get_order
from app.orders.cancellation_model import cancel_order
from app.orders.create import create_order
from app.orders.events import _opposite_direction, post_event
from app.orders.mutations import update_order
from app.finance.balances import pool_balance
from app.orders.queries import list_orders, order_customer_count
from app.orders.router_output import _order_list_payload

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


