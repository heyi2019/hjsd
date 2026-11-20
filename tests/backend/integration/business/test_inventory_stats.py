"""CALC-01 库存卡片指标的聚合口径（ACC-01 库存中心）。

前端原本在页面里做 `reduce((sum, row) => sum + Number(row.cost_amount))`
与两遍日期差过滤，一是不符合「派生值由后端算」，二是 `Number()` 累加在
分位上会出现 0.30000000000000004 这类残渣。改为前端只交出「此刻可见的
账号集合」，后端按集合汇总：

1. 占用成本按 Decimal 精确相加（三笔 0.10/0.20/0.00 必须等于 0.30）；
2. 集合外的账号不参与汇总（筛选语义仍只有一份：前端视图）；
3. 库龄档位 7 天 / 30 天为「严格大于」，与前端原有 `days > 7` 一致；
4. 空集合返回全 0，不报错（清空筛选或空库时页面照常渲染）。
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal

from app.business.stocks.inventory import inventory_stats
from app.business.stocks.profile import create_account


def _account(seeded_db, game_account: str, *, cost: str = "0", entry_days_ago: int | None = None):
    account = create_account(
        seeded_db,
        game_account=game_account,
        actor="pytest",
        business_mode="SELF",
        inventory_type="RECOVERY",
    )
    account.cost_amount = Decimal(cost)
    if entry_days_ago is not None:
        # 取当日 0 点：库龄按「满 24 小时」计，带时分会让第 7 天被算成 6 天。
        account.inventory_entry_at = datetime.combine(
            date.today() - timedelta(days=entry_days_ago), time(0, 0)
        )
    seeded_db.flush()
    return account


def test_occupied_cost_sums_with_decimal_and_never_drifts(seeded_db):
    first = _account(seeded_db, "stats-decimal-1", cost="0.10")
    second = _account(seeded_db, "stats-decimal-2", cost="0.20")
    third = _account(seeded_db, "stats-decimal-3", cost="0.00")

    stats = inventory_stats(
        seeded_db, account_ids=[first.id, second.id, third.id]
    )

    # float 累加会得到 0.30000000000000004，Decimal 必须精确到分。
    assert stats["occupied_cost"] == Decimal("0.30")
    assert stats["account_count"] == 3


def test_only_given_account_ids_take_part_in_totals(seeded_db):
    visible = _account(seeded_db, "stats-visible", cost="100.00")
    hidden = _account(seeded_db, "stats-hidden", cost="900.00")

    stats = inventory_stats(seeded_db, account_ids=[visible.id])

    assert stats["account_count"] == 1
    assert stats["occupied_cost"] == Decimal("100.00")
    assert hidden.id != visible.id


def test_stats_uses_database_aggregate_instead_of_loading_account_rows(seeded_db, monkeypatch):
    account = _account(seeded_db, "stats-aggregate", cost="20.00", entry_days_ago=8)

    def fail_row_loader(*_args, **_kwargs):
        raise AssertionError("库存统计不应加载账号实体行")

    monkeypatch.setattr(seeded_db, "scalars", fail_row_loader)
    stats = inventory_stats(seeded_db, account_ids=[account.id])

    assert stats["account_count"] == 1
    assert stats["occupied_cost"] == Decimal("20.00")
    assert stats["over_7d_count"] == 1


def test_age_buckets_are_strictly_greater_than_7_and_30_days(seeded_db):
    fresh = _account(seeded_db, "stats-age-7", cost="0", entry_days_ago=7)
    aging = _account(seeded_db, "stats-age-8", cost="0", entry_days_ago=8)
    stale = _account(seeded_db, "stats-age-31", cost="0", entry_days_ago=31)

    stats = inventory_stats(
        seeded_db, account_ids=[fresh.id, aging.id, stale.id]
    )

    # 第 7 天不算「超 7 天」；第 8 天算超 7 不算超 30；第 31 天两档都算。
    assert stats["over_7d_count"] == 2
    assert stats["over_30d_count"] == 1


def test_unknown_ids_are_ignored_instead_of_failing(seeded_db):
    account = _account(seeded_db, "stats-known", cost="20.00")

    stats = inventory_stats(seeded_db, account_ids=[account.id, 999_999])

    assert stats["account_count"] == 1
    assert stats["occupied_cost"] == Decimal("20.00")


def test_empty_selection_returns_zeros(seeded_db):
    stats = inventory_stats(seeded_db, account_ids=[])

    assert stats == {
        "account_count": 0,
        "occupied_cost": Decimal("0.00"),
        "over_7d_count": 0,
        "over_30d_count": 0,
    }


def test_legacy_inventory_stats_endpoint_is_removed(seeded_client, headers):
    response = seeded_client.post(
        "/api/stocks/inventory/stats",
        json={"account_ids": []},
        headers=headers,
    )

    assert response.status_code == 404
