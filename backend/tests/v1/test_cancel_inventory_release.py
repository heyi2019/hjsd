"""无流水取消后的库存回收规则。

判定依据是「有无已登记（过账）资金事件」：无事件时账号状态从未因本单改变过，
因此只有本单内联建库产生的账号需要在取消后收回，引用已有库存账号的单保持原状。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import Validation
from app.domain.enums import AccountStatus
from app.domain.trade import Account
from app.orders import service as order_service
from app.stocks import inventory as inventory_service

D = date(2026, 11, 1)


def _snapshot(game_account: str) -> dict[str, str]:
    return {"game_account": game_account, "game_type": "王者荣耀"}


def _inventory_ids(session) -> set[int]:
    return {row["account_id"] for row in inventory_service.inventory(session)}


def test_hs_plain_cancel_voids_inline_account_and_exits_inventory(seeded_db):
    """内联建库的回收单无流水取消后，账号退出库存，不再可被误卖。"""
    order = order_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-inline-hs"),
    )
    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    assert (account.status, account.inventory_status) == ("WAITING", "IN_STOCK")
    assert account.id in _inventory_ids(seeded_db)

    order_service.cancel_order(seeded_db, order.id, actor="pytest", reason="客户撤单")
    seeded_db.refresh(account)

    assert account.status == AccountStatus.VOID.value
    assert account.inventory_status == "OUT_OF_STOCK"
    assert account.id not in _inventory_ids(seeded_db)
    # 历史行保留：前端建单判重靠 status=VOID 排除它，而不是靠物理删除。
    assert account.id in {row.id for row in inventory_service.list_accounts(seeded_db)}


def test_cancelled_inline_account_allows_same_game_account_rebuy(seeded_db):
    """取消后同一游戏账号可以重新建单，不被「已有未售出库存账号」挡下。"""
    first = order_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-then-rebuy"),
    )
    order_service.cancel_order(seeded_db, first.id, actor="pytest", reason="客户撤单")

    second = order_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-then-rebuy"),
    )

    assert second.account_id != first.account_id
    reborn = seeded_db.get(Account, second.account_id)
    assert (reborn.status, reborn.inventory_status) == ("WAITING", "IN_STOCK")
    # 只有新账号在库，被取消那张保持 VOID，不会出现两条在库记录。
    assert _inventory_ids(seeded_db) == {reborn.id}


def test_referenced_account_keeps_status_on_plain_cancel(seeded_db):
    """引用已有库存账号的单取消后，共享账号保持原状，不被连带作废。"""
    source = order_service.create_order(
        seeded_db,
        order_type="TH",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-referenced"),
    )
    account = seeded_db.get(Account, source.account_id)
    assert account.status == AccountStatus.WAITING.value

    borrower = order_service.create_order(
        seeded_db,
        order_type="TH",
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    order_service.cancel_order(seeded_db, borrower.id, actor="pytest", reason="客户撤单")
    seeded_db.refresh(account)

    # 账号仍被回收单引用，取消提号单不应让它退出库存。
    assert account.status == AccountStatus.WAITING.value
    assert account.inventory_status == "IN_STOCK"


def test_plain_cancel_with_posted_event_is_blocked_and_account_untouched(seeded_db):
    """有已登记事件时仍拦下要求先冲销，且不擅自改账号状态。"""
    order = order_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("cancel-with-event"),
    )
    account = seeded_db.get(Account, order.account_id)
    order_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("100"),
        occurred_on=D,
        actor="pytest",
    )
    before = (account.status, account.inventory_status)

    with pytest.raises(Validation, match="登记事件"):
        order_service.cancel_order(seeded_db, order.id, actor="pytest", reason="不能直接取消")

    seeded_db.refresh(account)
    assert (account.status, account.inventory_status) == before


def test_dg_platform_offsale_keeps_account_in_stock(seeded_db):
    """代挂「平台下架」只终止本系统订单，账号仍在平台挂出，不退出库存。"""
    order = order_service.create_order(
        seeded_db,
        order_type="DG",
        trade_date=D,
        actor="pytest",
        account_snapshot=_snapshot("dg-platform-offsale"),
    )
    account = seeded_db.get(Account, order.account_id)

    order_service.cancel_order(
        seeded_db,
        order.id,
        actor="pytest",
        reason="平台下架",
        form_extra_scope="INVOID",
        form_extra={"platform_unlist_scope": "PLATFORM"},
    )
    seeded_db.refresh(account)

    assert account.status == AccountStatus.WAITING.value
    assert account.inventory_status == "IN_STOCK"
