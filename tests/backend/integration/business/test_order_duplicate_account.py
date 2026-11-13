"""INVENTORY-01 建单判重：同一游戏账号 + 游戏类型不得重复进入库存。

判重口径由后端统一承担（原前端 CreateBusinessModal 的弹窗判重已删除）：
未售出直接拒绝，已售出需显式 ``confirm_repurchase`` 确认，``VOID`` 不参与。
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.errors import ErrorCode, Validation
from app.orders.cancellation_model import cancel_order
from app.orders.create import create_order
from app.orders.events import post_event

D = date(2026, 11, 1)


def _snapshot(game_account: str, game_type: str = "王者荣耀") -> dict[str, str]:
    return {"game_account": game_account, "game_type": game_type}


def _create(session, game_account: str, order_type: str = "HS", **kwargs):
    return create_order(
        session,
        order_type=order_type,
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot(game_account),
        **kwargs,
    )


def _sell(session, order) -> None:
    """售出前必须先有采购入库记录，否则事件规则会拦下。"""
    post_event(
        session, order.id, event_type="BUY", amount="100",
        occurred_on=D, actor="pytest",
    )
    post_event(
        session, order.id, event_type="SELL", amount="150",
        occurred_on=D, actor="pytest",
    )


def test_unsold_duplicate_is_rejected(seeded_db):
    """已有未售出账号时直接拒绝，避免同一账号重复入库。"""
    _create(seeded_db, "dup-unsold")

    with pytest.raises(Validation) as excinfo:
        _create(seeded_db, "dup-unsold")

    assert excinfo.value.code == ErrorCode.INVENTORY_ACCOUNT_IN_STOCK
    assert excinfo.value.details["game_account"] == "dup-unsold"
    assert excinfo.value.details["account_ids"]


def test_sold_duplicate_requires_confirmation(seeded_db):
    """仅有已售出记录时要求确认复购回流，不直接拒绝。"""
    order = _create(seeded_db, "dup-sold")
    _sell(seeded_db, order)

    with pytest.raises(Validation) as excinfo:
        _create(seeded_db, "dup-sold")

    assert excinfo.value.code == ErrorCode.REPURCHASE_CONFIRM_REQUIRED
    assert excinfo.value.details["stock_nos"]


def test_confirmed_repurchase_is_allowed(seeded_db):
    """显式确认后放行，形成新的库存账号。"""
    order = _create(seeded_db, "dup-repurchase")
    _sell(seeded_db, order)

    rebought = _create(seeded_db, "dup-repurchase", confirm_repurchase=True)

    assert rebought.id != order.id
    assert rebought.account_id != order.account_id


def test_voided_account_does_not_block(seeded_db):
    """已取消（VOID）的账号不参与判重，同账号可立即重新建单。"""
    order = _create(seeded_db, "dup-voided")
    cancel_order(seeded_db, order.id, actor="pytest", reason="客户撤单")

    reborn = _create(seeded_db, "dup-voided")

    assert reborn.account_id != order.account_id


def test_different_game_type_is_not_a_duplicate(seeded_db):
    """判重按「游戏账号 + 游戏类型」双键，不同游戏类型不算重复。"""
    _create(seeded_db, "dup-cross-game")

    other = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("dup-cross-game", game_type="和平精英"),
    )

    assert other.id


def test_referenced_account_creation_skips_duplicate_check(seeded_db):
    """同类型订单引用已有库存账号时不重复创建库存，也不触发判重。"""
    source = _create(seeded_db, "dup-referenced", order_type="TH")

    borrowed = create_order(
        seeded_db,
        order_type="TH",
        trade_date=D,
        actor="pytest",
        account_id=source.account_id,
    )

    assert borrowed.account_id == source.account_id
