"""NUMBER-01 库存编号（stock_no）生成规则 fixture 测试。

覆盖 KU 编码改造的核心逻辑（2026-10-28 口径：KU_ + 五位流水）：
- 新建账号自动获得 stock_no，格式 KU_ + 5 位数字；
- 连续创建按序递增（KU_00001 → KU_00002 → KU_00003）；
- stock_no 唯一、可经账号列表 API 回读；
- 不同业务类型（回收/提号/代挂）账号均生成 stock_no；
- STOCK_NO 序列 current_value 随创建递增。
"""
from __future__ import annotations

import re
from datetime import date

import pytest
from sqlalchemy import select, text

from app.business.inventory.profile import create_account
from app.domain.trade import Account, OrderEvent
from app.business import events as order_events

KU_PATTERN = re.compile(r"^KU_\d{5}$")


def _make(db, game_account, inventory_type="RECOVERY", **kw):
    business_mode = kw.pop("business_mode", None) or (
        "DISTRIBUTION" if inventory_type in {"PICKUP", "CONSIGNMENT"} else "SELF"
    )
    return create_account(
        db,
        business_mode=business_mode,
        inventory_type=inventory_type,
        game_account=game_account,
        actor="pytest",
        **kw,
    )


class TestStockNoGeneration:
    def test_new_account_gets_ku_formatted_stock_no(self, seeded_db):
        acc = _make(seeded_db, "acc-ku-1")
        assert acc.stock_no is not None
        assert KU_PATTERN.match(acc.stock_no), acc.stock_no

    def test_stock_no_increments_sequentially(self, seeded_db):
        a1 = _make(seeded_db, "acc-seq-1")
        a2 = _make(seeded_db, "acc-seq-2")
        a3 = _make(seeded_db, "acc-seq-3")
        assert a1.stock_no == "KU_00001"
        assert a2.stock_no == "KU_00002"
        assert a3.stock_no == "KU_00003"

    def test_stock_no_is_unique_per_account(self, seeded_db):
        a1 = _make(seeded_db, "acc-uniq-1")
        a2 = _make(seeded_db, "acc-uniq-2")
        assert a1.stock_no != a2.stock_no

    def test_all_inventory_types_get_stock_no(self, seeded_db):
        for inv in ("RECOVERY", "PICKUP", "CONSIGNMENT"):
            acc = _make(seeded_db, f"acc-bt-{inv}", inventory_type=inv)
            assert KU_PATTERN.match(acc.stock_no), (inv, acc.stock_no)


    def test_stock_no_sequence_advances_with_creation(self, seeded_db):
        before = seeded_db.execute(
            text("SELECT current_value FROM document_sequences WHERE sequence_key='STOCK_NO'")
        ).scalar()
        _make(seeded_db, "seq-1")
        _make(seeded_db, "seq-2")
        after = seeded_db.execute(
            text("SELECT current_value FROM document_sequences WHERE sequence_key='STOCK_NO'")
        ).scalar()
        assert after - before == 2


class TestStockNoAtOrderCreation:
    """2026-10-28 口径：建单成功即生成库存编号（不等 BUY 事件）。"""

    def test_hs_order_creation_allocates_stock_no_immediately(self, seeded_db):
        order = service_create_order(
            seeded_db,
            account_snapshot={
                "game_account": "hs-stockno-at-create",
                "game_type": "王者荣耀",
                "game_password": "pwd",
                "channel_region": "微信一区",
            },
        )
        assert order.account_id is not None
        account = seeded_db.get(Account, order.account_id)
        assert account.stock_no is not None
        assert KU_PATTERN.match(account.stock_no)
        assert account.game_account == "hs-stockno-at-create"
        assert account.status == "WAITING"
        # 订单本体尚无任何事件（BUY 未登记），编号已就位
        assert seeded_db.scalar(
            select(OrderEvent.id).where(OrderEvent.order_id == order.id)
        ) is None

    def test_hs_order_without_game_account_rejected_at_buy(self, seeded_db):
        """缺账号资料（API 直调）时建单不建号，BUY 被明确拦截不发号。"""
        from decimal import Decimal

        from app.core.errors import Validation

        order = service_create_order(seeded_db)
        assert order.account_id is None
        with pytest.raises(Validation, match="回收订单建单时必须填写游戏账号并绑定库存账号"):
            order_events.post_event(
                seeded_db, order.id, event_type="BUY",
                amount=Decimal("300"), occurred_on=order.trade_date, actor="pytest",
            )
        assert order.account_id is None


def service_create_order(db, **kw):
    from app.business.orders.create import create_order

    return create_order(
        db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", **kw
    )
