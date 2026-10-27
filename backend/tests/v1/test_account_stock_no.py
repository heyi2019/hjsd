"""库存编号（stock_no）生成规则 fixture 测试。

覆盖 KU 编码改造的核心逻辑：
- 新建账号自动获得 stock_no，格式 KU + 4 位数字；
- 连续创建按序递增（KU0001 → KU0002 → KU0003）；
- stock_no 唯一、可经账号列表 API 回读；
- 不同业务类型（回收/提号/代挂/代分期衍生）账号均生成 stock_no；
- STOCK_NO 序列 current_value 随创建递增。
"""
from __future__ import annotations

import re

import pytest
from sqlalchemy import text

from app.accounts import service

KU_PATTERN = re.compile(r"^KU\d{4}$")


def _make(db, game_account, inventory_type="RECOVERY", **kw):
    business_mode = kw.pop("business_mode", None) or (
        "DISTRIBUTION" if inventory_type in {"PICKUP", "CONSIGNMENT"} else "SELF"
    )
    return service.create_account(
        db,
        business_mode=business_mode,
        inventory_type=inventory_type,
        game_account=game_account,
        platform="王者",
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
        assert a1.stock_no == "KU0001"
        assert a2.stock_no == "KU0002"
        assert a3.stock_no == "KU0003"

    def test_stock_no_is_unique_per_account(self, seeded_db):
        a1 = _make(seeded_db, "acc-uniq-1")
        a2 = _make(seeded_db, "acc-uniq-2")
        assert a1.stock_no != a2.stock_no

    def test_all_inventory_types_get_stock_no(self, seeded_db):
        for inv in ("RECOVERY", "PICKUP", "CONSIGNMENT"):
            acc = _make(seeded_db, f"acc-bt-{inv}", inventory_type=inv)
            assert KU_PATTERN.match(acc.stock_no), (inv, acc.stock_no)

    def test_dfq_advance_purchase_account_gets_stock_no(self, seeded_db):
        acc = _make(
            seeded_db,
            "acc-dfq-1",
            inventory_type="RECOVERY",
            value_added_service="ADVANCE_PURCHASE",
        )
        assert KU_PATTERN.match(acc.stock_no)

    def test_stock_no_visible_in_accounts_list_api(self, seeded_client, headers, seeded_db):
        _make(seeded_db, "api-acc-1")
        resp = seeded_client.get("/api/v1/accounts", headers=headers)
        assert resp.status_code == 200
        payload = resp.json()
        items = payload if isinstance(payload, list) else payload.get("items") or payload.get("data")
        matched = [a for a in items if a.get("game_account") == "api-acc-1"]
        assert matched, "api-acc-1 未出现在账号列表"
        assert KU_PATTERN.match(matched[0]["stock_no"]), matched[0]["stock_no"]

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
