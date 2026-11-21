"""AUTH-01 tests/backend/test_orders_router_guard：orders.router 守卫/权限分支覆盖收口。

直接调用 router 函数（绕过 FastAPI DI 的依赖工厂），触发业务校验与权限拦截分支，
不依赖完整 HTTP 链路，保持与批2-4 守门用例一致的轻量风格。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.core.errors import NotFound, PermissionDenied, Validation
from app.core.security import CurrentUser
from app.domain.trade import Account
from app.domain.enums import AccountStatus
from app.business.orders import schemas
from app.business.orders.create import create_order
from app.business.orders.router_output import _order_list_payload, _order_output
from app.business.orders.routers.orders_router import create_order as create_order_endpoint
from app.customers.counterparties import create_counterparty
from app.customers.customers import create_customer

TODAY = date(2026, 10, 4)

def _admin() -> CurrentUser:
    return CurrentUser.build(id=1, username="admin", roles=["ADMIN"])

def _viewer() -> CurrentUser:
    return CurrentUser.build(id=2, username="viewer", roles=["VIEWER"], owner_scope="SELF")

def _auditor() -> CurrentUser:
    return CurrentUser.build(id=3, username="auditor", roles=["AUDITOR"], owner_scope="SELF")

def _finance() -> CurrentUser:
    return CurrentUser.build(id=4, username="finance", roles=["FINANCE"], owner_scope="SELF")

def _new_account(
    seeded_db,
    *,
    game_account: str = "router-acc-001",
    business_mode: str = "SELF",
    inventory_type: str = "RECOVERY",
) -> Account:
    account = Account(
        game_account=game_account,
        business_mode=business_mode,
        inventory_type=inventory_type,
        status=AccountStatus.WAITING.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(account)
    seeded_db.commit()
    return account

# ---- create_order 业务校验分支（在 service 调用前即拦截，无需有效账号） ----

def test_create_order_rejects_embedded_installment_payload():
    # 分期只在库存售出动作中建立，建单契约不再保留不可达字段。
    with pytest.raises(ValidationError, match="extra_forbidden"):
        schemas.OrderCreate(
            order_type="TH",
            trade_date=TODAY,
            installment={
                "contract_type": "PICKUP_SALE",
                "periods": 1,
                "first_due_on": TODAY,
                "principal": Decimal("0"),
            },
        )


def test_create_order_rejects_operation_form_scope():
    # 建单只接受订单自身字段作用域，库存操作作用域不应通过兼容字段注入。
    with pytest.raises(ValidationError, match="extra_forbidden"):
        schemas.OrderCreate(
            order_type="DG",
            trade_date=TODAY,
            form_extra_scope="CONSIGN",
        )

def test_create_order_initial_cost_requires_buy_on_hs_th(seeded_db):
    # 373: 初始费用仅适用于同时提交初始买入的回收/提号订单
    payload = schemas.OrderCreate(
        order_type="HS",
        trade_date=TODAY,
        initial_costs=[schemas.InitialCostCreate(amount=Decimal("0"), occurred_on=TODAY)],
    )
    with pytest.raises(Validation, match="初始费用仅适用于同时提交初始买入的回收或提号订单"):
        create_order_endpoint(payload, db=seeded_db, user=_admin())

# ---- create_order 权限拦截分支 ----

def test_create_order_hs_initial_buy_requires_event_perm(seeded_db):
    # 376: HS 初始买入需 order.event.post 或 finance.order.event.post
    payload = schemas.OrderCreate(
        order_type="HS",
        trade_date=TODAY,
        initial_buy=schemas.InitialBuyCreate(amount=Decimal("0"), occurred_on=TODAY),
    )
    with pytest.raises(PermissionDenied, match="无权登记买入事件"):
        create_order_endpoint(payload, db=seeded_db, user=_auditor())

def test_create_order_hs_initial_cost_requires_event_perm(seeded_db):
    # 378: HS 初始费用需 order.event.post（财务仅可登记买卖事件）
    payload = schemas.OrderCreate(
        order_type="HS",
        trade_date=TODAY,
        initial_buy=schemas.InitialBuyCreate(amount=Decimal("0"), occurred_on=TODAY),
        initial_costs=[schemas.InitialCostCreate(amount=Decimal("0"), occurred_on=TODAY)],
    )
    with pytest.raises(PermissionDenied, match="无权登记费用事件"):
        create_order_endpoint(payload, db=seeded_db, user=_finance())

# ---- _order_output：订单主列表保留账号密码字段（按当前详情编辑口径） ----

def test_order_output_keeps_game_password_for_detail_editing(seeded_db):
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_snapshot={"game_account": "x", "game_password": "secret"},
        user=_admin(),
    )
    seeded_db.commit()
    out = _order_output(order)
    assert out.account_snapshot is not None
    assert out.account_snapshot.get("game_password") == "secret"

# ---- _order_list_payload：客户/对手方角色回写（249 / 255） ----

def test_order_list_payload_includes_customer_role(seeded_db):
    from sqlalchemy import event

    account = _new_account(seeded_db)
    customer = create_customer(seeded_db, display_name="甲", actor="pytest")
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
        customer_roles=[(customer.id, "BUYER")],
        user=_admin(),
    )
    seeded_db.commit()
    queries = []
    account_queries = []

    def record_sql(_conn, _cursor, statement, _params, _context, _many):
        sql = " ".join(statement.lower().split())
        if "from order_customer_roles join customers" in sql or "from order_counterparty_roles join counterparties" in sql:
            queries.append(sql)
        if "from stocks" in sql:
            account_queries.append(sql)

    connection = seeded_db.connection()
    event.listen(connection, "after_cursor_execute", record_sql)
    try:
        payloads = _order_list_payload(seeded_db, [order])
    finally:
        event.remove(connection, "after_cursor_execute", record_sql)
    assert payloads[0]["party_name"] == "甲"
    assert payloads[0]["party_role"] == "BUYER"
    assert len(queries) == 2
    assert all(".phone" not in query and ".wechat" not in query and ".note" not in query for query in queries)
    assert payloads[0]["account_game_account"] == account.game_account
    assert len(account_queries) == 1
    assert "stocks.game_password" not in account_queries[0]
    assert "stocks.secondary_images" not in account_queries[0]
    assert "stocks.wallet_realname_images" not in account_queries[0]
    assert "stocks.account_images" not in account_queries[0]

def test_order_list_payload_includes_counterparty_role(seeded_db):
    account = _new_account(
        seeded_db,
        game_account="router-th-acc",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
    )
    cp = create_counterparty(
        seeded_db, display_name="同行乙", type="PEER", actor="pytest"
    )
    order = create_order(
        seeded_db,
        order_type="TH",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
        counterparty_roles=[(cp.id, "PEER")],
        user=_admin(),
    )
    seeded_db.commit()
    payloads = _order_list_payload(seeded_db, [order])
    assert payloads[0]["party_name"] == "同行乙"
    assert payloads[0]["party_role"] == "PEER"

# ---- pool_balance：无池授权返回 NotFound（端点 2026-11-18 归位 finance/balances_router，URL 不变） ----

def test_pool_balance_hidden_for_unauthorized_viewer(seeded_db):
    from app.funds.routers.balances_router import pool_balance_detail

    with pytest.raises(NotFound, match="资金账户不存在"):
        pool_balance_detail(1, db=seeded_db, _user=_viewer())
