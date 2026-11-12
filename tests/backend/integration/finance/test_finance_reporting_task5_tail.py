"""REPORT-01 Task #5 收口：finance / reporting 剩余覆盖（直调内部函数绕过 DI）。

覆盖目标（行号来自 coverage 基线）：
- app/finance/deposits.py::cancel_deposit  cancel_deposit 服务层 押金不存在 NotFound
- app/finance/rebates.py:179/182       _rebate_base_from_snapshot snapshot 空 / config 非 dict
- app/finance/router.py:492-495/503    cancel_deposit 端点（未知 + 成功两条路径）
- app/reporting/export.py::report_csv   normalize：None 与复合值序列化

返点分次结算（`rebate_settlements`）模型层已于 2026-11-05 下线，原针对
`reverse_rebate_settlement` / `void_rebate` 结算分支的辅助函数与用例一并移除。
"""
from __future__ import annotations

import csv
import io

from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.finance import deposits, rebates, router as finance_router, schemas
from app.reporting.export import report_csv
from app.reporting.funds import daily_funds_report

TODAY = date(2026, 10, 17)


def _admin() -> CurrentUser:
    # owner_scope=ALL 且显式授权 pool 1：任何 can_see_pool 判定都为可见。
    return CurrentUser(
        id=1, username="admin", roles=(), owner_scope="ALL", pool_ids=frozenset({1})
    )


def _order_with_buy(seeded_db):
    from app.stocks.profile import create_account
    from app.orders.create import create_order
    from app.orders.events import post_event

    account = create_account(
        seeded_db, game_account="task5-account", business_mode="SELF",
        inventory_type="RECOVERY", actor="pytest",
    )
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
        occurred_on=TODAY, actor="pytest", pool_id=1,
    )
    return order.id


# ------------------------------------------------- deposits.py::cancel_deposit
def test_cancel_deposit_unknown_raises(seeded_db):
    with pytest.raises(NotFound, match="押金.*不存在"):
        deposits.cancel_deposit(
            seeded_db, 999999, cancelled_on=TODAY, reason="x", actor="pytest",
        )


# ----------------------------------------------------------- rebates.py:179 / 182
def test_rebate_base_from_snapshot_empty(seeded_db):
    assert rebates._rebate_base_from_snapshot(seeded_db, None, None) is None  # 179


def test_rebate_base_from_snapshot_config_not_dict(seeded_db):
    assert rebates._rebate_base_from_snapshot(seeded_db, {"config": "x"}, None) is None  # 182


# ----------------------------------------------------------- finance/router.py:492-495 / 503
def test_router_cancel_deposit_unknown(seeded_db):
    with pytest.raises(NotFound, match="押金不存在"):
        finance_router.cancel_deposit(
            999999, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
            db=seeded_db, user=_admin(),
        )  # 492-494


def test_router_cancel_deposit_success(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
    )
    out = finance_router.cancel_deposit(
        deposit.id, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
        db=seeded_db, user=_admin(),
    )  # 492-495 + 503
    assert out.id == deposit.id
    assert out.status == "CANCELLED"


# ----------------------------------------------------------- finance/router.py:601 / 604


# ----------------------------------------------------------- reporting/export.py::report_csv
def test_report_csv_normalizes_none_and_compound():
    csv_text = report_csv({
        "items": [
            {"name": "a", "note": None, "meta": {"k": 1}, "tags": [1, 2]},
        ],
        "total": {"name": "合计"},
    })
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    header = rows[0]
    item_row = next(r for r in rows if r[0] == "ITEM")
    # None -> 空字符串
    assert item_row[header.index("note")] == ""
    # dict / list -> JSON 序列化
    assert item_row[header.index("meta")] == '{"k": 1}'
    assert item_row[header.index("tags")] == "[1, 2]"


# ----------------------------------------------------------- reporting/funds.py::daily_funds_report
def test_daily_funds_report_aggregates_deposit(seeded_db):
    # 押金缴纳按池聚合分支，需存在 paid_on==target 的押金才执行。
    deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("50"), paid_on=TODAY, actor="pytest",
    )
    report = daily_funds_report(seeded_db, on=TODAY)
    assert any(Decimal(str(it["deposit_paid"])) > 0 for it in report["items"])
