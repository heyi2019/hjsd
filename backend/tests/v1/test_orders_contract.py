"""orders 订单/事件契约测试（ORD-01/02、FIN-01/03）。

与 test_orders.py / test_bughunt.py / test_m2.py 的分工：既有文件已覆盖四类业务建单、
BUY/COST/SELL/PAYMENT/DELIVER/CANCEL(无 offset) 过账、状态机、路由缺失等主路径；
本文件补NotFound/越权/过滤/非法入参分支、`_opposite_direction` 三分支、
`_apply_account_effect` 防御与 CANCEL 分支、以及 3 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import AccountStatus, CapitalType, OrderStatus
from app.domain.trade import Account, Order
from app.foundation import service as foundation_service
from app.orders import service as order_service

D = date(2026, 10, 4)


def _order(seeded_db, *, order_type="HS", account_id=None, owner_id=None, trade_date=D):
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
    def test_unknown_order_type_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            order_service.create_order(
                seeded_db, order_type="ZZ", trade_date=D, actor="pytest"
            )
        assert "不存在" in str(exc.value)

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


# ------------------------------------------------------------------ 查询与作用域
class TestGetAndListOrders:
    def test_get_order_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            order_service.get_order(seeded_db, 999999)

    def test_get_order_owner_scope_forbidden(self, seeded_db):
        # 他人 owner 的订单对 SELF 作用域用户同样 404（不泄露存在性）
        order = _order(seeded_db, owner_id=1)
        with pytest.raises(NotFound):
            order_service.get_order(seeded_db, order.id, _scoped_user())

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

        # 分支一：无 offset → 默认 IN（CANCEL 后订单即 CANCELLED，每分支独立建单）
        order_a = _order(seeded_db)
        _, _ = order_service.post_event(
            seeded_db, order_a.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        cancel_a, _ = order_service.post_event(
            seeded_db, order_a.id, event_type="CANCEL", amount="10.00",
            occurred_on=D, actor="pytest",
        )
        assert order_a.status == "CANCELLED"

        # 分支二：offset 指向 SELL → 方向取反为 OUT
        order_b = _order(seeded_db, order_type="TH")
        order_service.post_event(
            seeded_db, order_b.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        sell_event, _ = order_service.post_event(
            seeded_db, order_b.id, event_type="SELL", amount="150.00",
            occurred_on=D, actor="pytest",
        )
        cancel_b, _ = order_service.post_event(
            seeded_db, order_b.id, event_type="CANCEL", amount="10.00",
            occurred_on=D, actor="pytest", offset_event_id=sell_event.id,
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

    def test_cancel_offset_must_belong_to_the_same_order(self, seeded_db):
        first = _order(seeded_db)
        second = _order(seeded_db, order_type="TH")
        order_event, _ = order_service.post_event(
            seeded_db,
            second.id,
            event_type="SELL",
            amount="150.00",
            occurred_on=D,
            actor="pytest",
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
            )

        assert exc.value.code == ErrorCode.VALIDATION_ERROR
        assert "同一订单" in str(exc.value)


# ------------------------------------------------------------------ 账号效果
class TestAccountEffect:
    def test_cancel_reverses_cost_and_voids_account(self, seeded_db):
        account = Account(
            inventory_no="ACC-ORD-1",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order = _order(seeded_db, account_id=account.id)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        assert account.cost_amount == 500
        assert account.status == AccountStatus.IN_STOCK.value

        order_service.post_event(
            seeded_db, order.id, event_type="CANCEL", amount="500.00",
            occurred_on=D, actor="pytest",
        )
        assert account.cost_amount == 0
        assert account.status == AccountStatus.VOID.value

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
    def test_pool_balance_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            order_service.pool_balance(seeded_db, 999999)


# ------------------------------------------------------------------ 路由层
class TestOrdersApi:
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

        missing = seeded_client.get("/api/v1/orders/999999", headers=headers)
        assert missing.status_code == 404

    def test_pool_balance_endpoint_scope_forbidden(self, seeded_client, viewer_headers):
        # viewer 有 finance.read 但无池授权 → 越权池返回 404（不泄露存在性）
        response = seeded_client.get("/api/v1/pools/1/balance", headers=viewer_headers)
        assert response.status_code == 404

    def test_pool_balance_endpoint_ok(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/pools/1/balance", headers=headers)
        assert response.status_code == 200, response.text
        assert "available" in response.json()
