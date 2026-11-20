"""REBATE-01 返点服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.business.stocks.profile import create_account
from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.core.tokens import hash_password
from app.domain.users import User
from app.funds import rebates
from app.funds import cashflows
from app.business.create import create_order
from app.business.events import post_event
from app.business.form_fields import create_order_form_field
from app.domain.trade import Cashflow, Order, OrderEvent, OrderFormField, RebateRecord


TODAY = date(2026, 10, 17)


def _restricted_user() -> CurrentUser:
    return CurrentUser(
        id=999,
        username="restricted",
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset(),
        owner_scope="SELF",
    )


def _all_scope_user() -> CurrentUser:
    return CurrentUser(
        id=1,
        username="allscope",
        roles=(),
        owner_scope="ALL",
        pool_ids=frozenset(),
    )


_ACCOUNT_CONTEXT = {
    "HS": ("SELF", "RECOVERY"),
    "TH": ("DISTRIBUTION", "PICKUP"),
    "DG": ("DISTRIBUTION", "CONSIGNMENT"),
}


def _order_with_buy(seeded_db, order_type: str = "HS") -> int:
    business_mode, inventory_type = _ACCOUNT_CONTEXT[order_type]
    account = create_account(
        seeded_db,
        game_account=f"rebate-buy-{order_type.lower()}",
        business_mode=business_mode,
        inventory_type=inventory_type,
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type=order_type,
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("1000"),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=1,
    )
    return order.id


def _order_with_sell(seeded_db, order_type: str = "DG") -> int:
    business_mode, inventory_type = _ACCOUNT_CONTEXT[order_type]
    account = create_account(
        seeded_db,
        game_account=f"{order_type.lower()}-sell-rebate-account",
        business_mode=business_mode,
        inventory_type=inventory_type,
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type=order_type,
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    if order_type == "HS":
        # 回收单 SELL 前必须有采购入库（BUY）事件。
        post_event(
            seeded_db, order.id, event_type="BUY",
            amount=Decimal("1000"), occurred_on=TODAY, actor="pytest", pool_id=1,
        )
    post_event(
        seeded_db,
        order.id,
        event_type="SELL",
        amount=Decimal("1000"),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=1,
    )
    return order.id


def test_rebate_module_creates_record_directly(seeded_db):
    record = rebates.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        amount=Decimal("1000"),
        collected_on=TODAY,
        actor="pytest",
    )

    assert record.rebate_no.endswith("-RB01")


def test_rebate_creates_business_event_and_income_cashflow(seeded_db):
    order_id = _order_with_buy(seeded_db)
    record = rebates.create_rebate(
        seeded_db,
        source_order_id=order_id,
        rebate_type="BUY",
        amount=Decimal("1000"),
        collected_on=TODAY,
        actor="pytest",
    )

    event = seeded_db.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == order_id,
            OrderEvent.event_type == "REBATE",
        )
    )
    assert event is not None
    assert event.source_type == "REBATE"
    assert event.source_id == record.rebate_no
    flow = seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == "ORDER_EVENT",
        Cashflow.source_id == event.event_no,
    ))
    assert flow is not None
    assert flow.direction == "IN"
    assert flow.category == "REBATE"
    assert flow.amount == Decimal("1000.00")


def test_outflow_cashflow_does_not_create_refund_event(seeded_db):
    """退款已并入普通支出：OUT 资金明细走通用录入，不再产生 REFUND 业务事件。"""
    order_id = _order_with_sell(seeded_db, "DG")
    flow = cashflows.create_cashflow(
        seeded_db,
        pool_id=2,
        occurred_on=TODAY,
        direction="OUT",
        category="OTHER",
        amount=Decimal("200"),
        actor="pytest",
        order_id=order_id,
        note="客户售后退款（普通支出）",
    )

    assert flow.direction == "OUT"
    assert flow.category == "OTHER"
    # 挂单流水默认落「其他支出」——工作室运营支出只属于工作室账簿，
    # 订单资金明细不得误标（2026-11-18 口径，见 finance/attributes.py）。
    assert flow.accounting_attribute == "OTHER_EXPENSE"
    assert seeded_db.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order_id,
            OrderEvent.event_type == "REFUND",
        )
    ) is None


# ----------------------------------------------------- 返点类型与订单类型约束
def test_create_rebate_buy_rejects_dg(seeded_db):
    order_id = _order_with_sell(seeded_db)  # DG 订单已 ACTIVE
    with pytest.raises(Validation, match="买号返点只能关联回收、提号订单"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            amount=Decimal("1000"),
            collected_on=TODAY, actor="pytest",
        )  # 买号返点仅限 HS/TH，DG 不可


def test_create_rebate_buy_allows_th(seeded_db):
    """TH（提号）订单有 BUY 事件即可登记买号返点（2026-10-28 口径放开）。"""
    order_id = _order_with_buy(seeded_db, order_type="TH")
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        amount=Decimal("1000"),
        collected_on=TODAY, actor="pytest",
    )
    assert record.rebate_type == "BUY"


def test_create_rebate_sell_allows_created_order_without_sell_event(seeded_db):
    order_id = _order_with_buy(seeded_db)  # HS 订单只有 BUY 事件
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="SELL",
        amount=Decimal("1000"),
        collected_on=TODAY, actor="pytest",
    )
    assert record.rebate_type == "SELL"


@pytest.mark.parametrize(("dependency", "condition"), [
    ("rebate_type", {"field": "rebate_type", "op": "eq", "values": ["SELL"]}),
    ("amount", {"field": "amount", "op": "filled"}),
])
def test_rebate_conditions_use_real_parent_form_values(seeded_db, seeded_client, headers, dependency, condition):
    order_id = _order_with_buy(seeded_db)
    core = seeded_db.scalar(select(OrderFormField).where(
        OrderFormField.order_type_code == "INVREBATE", OrderFormField.field_key == dependency,
    ))
    if core is None:
        core = create_order_form_field(seeded_db, order_type_code="INVREBATE", field_key=dependency,
                                       label="依赖字段", actor="pytest")
        core.is_custom = False
        seeded_db.flush()
    create_order_form_field(seeded_db, order_type_code="INVREBATE", field_key="receipt", label="返点凭据",
                            actor="pytest", required_when=condition)
    seeded_db.commit()
    payload = {"source_order_id": order_id, "rebate_type": "SELL", "amount": "30", "collected_on": TODAY.isoformat()}
    response = seeded_client.post("/api/rebates", json=payload, headers=headers)
    assert response.status_code == 422 and "返点凭据" in response.text
    spoof = seeded_client.post("/api/rebates", json={**payload, "form_extra": {dependency: ""}}, headers=headers)
    assert spoof.status_code == 422 and "返点凭据" in spoof.text
    assert seeded_db.scalar(select(RebateRecord).where(RebateRecord.source_order_id == order_id)) is None
    saved = seeded_client.post("/api/rebates", json={**payload, "form_extra": {"receipt": "凭据A"}}, headers=headers)
    assert saved.status_code == 201, saved.text
    record = seeded_db.scalar(select(RebateRecord).where(RebateRecord.source_order_id == order_id))
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.source_type == "REBATE", OrderEvent.source_id == record.rebate_no))
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.source_id == event.event_no))
    assert record.form_extra["receipt"] == event.form_extra["receipt"] == flow.form_extra["receipt"] == "凭据A"
    if dependency == "rebate_type":
        untriggered = seeded_client.post("/api/rebates", json={**payload, "rebate_type": "BUY"}, headers=headers)
        assert untriggered.status_code == 201, untriggered.text


def test_create_rebate_sell_allows_hs_with_sell_event(seeded_db):
    """2026-10-28 口径：卖号返点不再限 DG，回收单有 SELL 事件即可。"""
    order_id = _order_with_sell(seeded_db, order_type="HS")
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="SELL",
        amount=Decimal("1000"),
        collected_on=TODAY, actor="pytest",
    )
    assert record.rebate_type == "SELL"


# ----------------------------------------------------- get_rebate 作用域 (571-586)
def test_get_rebate_no_user(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY", amount=Decimal("1000"),
        collected_on=TODAY, actor="pytest",
    )
    assert rebates.get_rebate(seeded_db, record.id) is record


def test_get_rebate_scope_hidden(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY", amount=Decimal("1000"),
        collected_on=TODAY, actor="pytest",
    )
    with pytest.raises(NotFound):
        rebates.get_rebate(seeded_db, record.id, user=_restricted_user())  # 574-585


def test_get_rebate_unknown(seeded_db):
    with pytest.raises(NotFound):
        rebates.get_rebate(seeded_db, 999999)  # 571-573


# ----------------------------------------------------- create_rebate 护栏
def test_create_rebate_rejects_cancelled_order(seeded_db):
    order_id = _order_with_buy(seeded_db)
    order = seeded_db.get(Order, order_id)
    order.status = "CANCELLED"
    seeded_db.flush()
    with pytest.raises(Validation, match="不可作为返点来源"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            amount=Decimal("1000"), collected_on=TODAY, actor="pytest",
        )


def test_create_rebate_rejects_duplicate_operators(seeded_db):
    order_id = _order_with_buy(seeded_db)
    with pytest.raises(Validation, match="操作人不能重复选择"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            amount=Decimal("1000"), collected_on=TODAY, actor="pytest",
            operator_user_ids=[1, 1],
        )


def test_create_rebate_rejects_missing_operator(seeded_db):
    order_id = _order_with_buy(seeded_db)
    with pytest.raises(Validation, match="所选操作人不存在或已停用"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            amount=Decimal("1000"), collected_on=TODAY, actor="pytest",
            operator_user_ids=[99999],
        )


def _operator_user(seeded_db, username: str, *, is_active: bool = True) -> User:
    user = User(
        username=username,
        display_name=username.upper(),
        password_hash=hash_password("op-pass-123"),
        role="OPERATOR",
        owner_scope="SELF",
        pool_ids=[],
        team_ids=[],
        is_active=is_active,
    )
    seeded_db.add(user)
    seeded_db.flush()
    return user


def test_create_rebate_rejects_inactive_operator(seeded_db):
    user = _operator_user(seeded_db, "rb-inactive", is_active=False)
    order_id = _order_with_buy(seeded_db)
    with pytest.raises(Validation, match="所选操作人不存在或已停用"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            amount=Decimal("1000"), collected_on=TODAY, actor="pytest",
            operator_user_ids=[user.id],
        )


def test_create_rebate_accepts_active_operator(seeded_db):
    user = _operator_user(seeded_db, "rb-active")
    order_id = _order_with_buy(seeded_db)
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        amount=Decimal("1000"), collected_on=TODAY, actor="pytest",
        operator_user_ids=[user.id],
    )
    assert record.operator_user_ids == [user.id]


# ----------------------------------------------------- update_rebate 编辑同步
def test_update_rebate_syncs_event_and_flow(seeded_db):
    user = _operator_user(seeded_db, "rb-editor")
    order_id = _order_with_buy(seeded_db)
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        amount=Decimal("800"), collected_on=TODAY, actor="pytest", note="旧备注",
    )
    new_day = date(2026, 10, 20)
    updated = rebates.update_rebate(
        seeded_db, record.id, actor="pytest",
        amount=Decimal("500"), collected_on=new_day, note="新备注",
        operator_user_ids=[user.id], form_extra={"对接渠道": "支付宝"},
    )
    assert updated.amount == Decimal("500")
    assert updated.collected_on == new_day
    assert updated.note == "新备注"
    assert updated.operator_user_ids == [user.id]
    # 事件与资金流水同步：报表同源（三账一致）
    event = seeded_db.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == order_id, OrderEvent.event_type == "REBATE",
        )
    )
    assert event.amount == Decimal("500")
    assert event.occurred_on == new_day
    assert event.note == "新备注"
    flow = seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == "ORDER_EVENT",
        Cashflow.source_id == event.event_no,
    ))
    assert flow.amount == Decimal("500.00")
    assert flow.occurred_on == new_day


def test_update_rebate_without_action_event_still_updates_record(seeded_db):
    """事件未回指返点记录（source_id 为空）：编辑只更新返点记录本身。"""
    order_id = _order_with_buy(seeded_db)
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        amount=Decimal("800"), collected_on=TODAY, actor="pytest",
    )
    event = seeded_db.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == order_id, OrderEvent.event_type == "REBATE",
        )
    )
    event.source_id = None  # 拆掉 source_id 回指
    seeded_db.flush()
    updated = rebates.update_rebate(
        seeded_db, record.id, actor="pytest", amount=Decimal("300"),
    )
    assert updated.amount == Decimal("300")
    # 无回指则事件金额未被联动，流水保持原值
    assert event.amount == Decimal("800")
