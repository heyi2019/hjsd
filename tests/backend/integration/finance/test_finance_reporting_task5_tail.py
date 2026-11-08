"""FIN-01 财务边界行为：押金取消、报表导出和资金日报。"""
from __future__ import annotations

import csv
import io

from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import Cashflow
from app.finance import cashflows, router as finance_router, schemas
from app.reporting import service as reporting_service

TODAY = date(2026, 10, 17)


def _admin() -> CurrentUser:
    # owner_scope=ALL 且显式授权 pool 1：任何 can_see_pool 判定都为可见。
    return CurrentUser(
        id=1, username="admin", roles=(), owner_scope="ALL", pool_ids=frozenset({1})
    )


# ------------------------------------------------- 押金取消
def test_cancel_deposit_unknown_raises(seeded_db):
    with pytest.raises(NotFound, match="押金.*不存在"):
        cashflows.cancel_deposit(
            seeded_db, 999999, cancelled_on=TODAY, reason="x", actor="pytest",
        )


# ----------------------------------------------------------- 路由层押金取消
def test_router_cancel_deposit_unknown(seeded_db):
    with pytest.raises(NotFound, match="押金不存在"):
        finance_router.cancel_deposit(
            999999, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
            db=seeded_db, user=_admin(),
        )


def test_router_cancel_deposit_success(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
    )
    out = finance_router.cancel_deposit(
        deposit.id, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
        db=seeded_db, user=_admin(),
    )
    assert out.id == deposit.id
    assert out.status == "CANCELLED"


# ----------------------------------------------------------- 报表导出值规范化
def test_report_csv_normalizes_none_and_compound():
    csv_text = reporting_service.report_csv({
        "items": [
            {"name": "a", "note": None, "meta": {"k": 1}, "tags": [1, 2]},
        ],
        "total": {"name": "合计"},
    })
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    header = rows[0]
    item_row = next(r for r in rows if r[0] == "ITEM")
    # None 导出为空字符串。
    assert item_row[header.index("note")] == ""
    # dict / list 导出为 JSON。
    assert item_row[header.index("meta")] == '{"k": 1}'
    assert item_row[header.index("tags")] == "[1, 2]"


# ----------------------------------------------------------- 资金日报聚合
def test_daily_funds_report_aggregates_deposit(seeded_db):
    # 目标日期有押金缴纳时，日报按资金池聚合押金收入。
    cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("50"), paid_on=TODAY, actor="pytest",
    )
    report = reporting_service.daily_funds_report(seeded_db, on=TODAY)
    assert any(Decimal(str(it["deposit_paid"])) > 0 for it in report["items"])


def _status_deposit(seeded_db, amount="300"):
    return cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal(amount), paid_on=date(2026, 10, 1), actor="pytest"
    )


def test_cancel_paid_deposit_writes_reversal(seeded_db):
    deposit = _status_deposit(seeded_db)
    out = cashflows.cancel_deposit(
        seeded_db, deposit.id, cancelled_on=date(2026, 10, 5), reason="押金登记有误", actor="pytest"
    )
    assert out.status == "CANCELLED"
    flows = [
        flow
        for flow in seeded_db.query(Cashflow).filter(Cashflow.deposit_id == deposit.id).all()
        if flow.category == "DEPOSIT_CANCEL"
    ]
    assert len(flows) == 1
    assert flows[0].amount == deposit.paid_amount


def test_cancel_returned_deposit_is_rejected(seeded_db):
    deposit = _status_deposit(seeded_db)
    cashflows.return_deposit(
        seeded_db, deposit.id, amount=Decimal("100"), released_on=date(2026, 10, 3), actor="pytest"
    )
    with pytest.raises(Validation):
        cashflows.cancel_deposit(
            seeded_db, deposit.id, cancelled_on=date(2026, 10, 5), reason="已发生退还不可取消", actor="pytest"
        )
