"""Task #5 收口：finance / reporting 剩余 16 行缺失（直调内部函数绕过 DI）。

覆盖目标（行号来自 coverage 基线）：
- app/finance/cashflows.py:261         reject_cashflow 带 form_extra 合并分支
- app/finance/cashflows.py:509         cancel_deposit 服务层 押金不存在 NotFound
- app/finance/rebates.py:179/182       _rebate_base_from_snapshot snapshot 空 / config 非 dict
- app/finance/rebates.py:645           void_rebate 零结算(OPEN)但已有结算流水的拒绝分支
- app/finance/rebates.py:429/463       reverse_rebate_settlement 关联 cashflow / fee 悬空
                                      （FK 保证不可达 -> 原生 sqlite3 绕过，见 _corrupt_settlement_fk）
- app/finance/router.py:492-495/503    cancel_deposit 端点（未知 + 成功两条路径）
- app/finance/router.py:601/604        void_rebate 端点
- app/reporting/service.py:130/132     report_csv 的 normalize：None 与复合值序列化
"""
from __future__ import annotations

import csv
import io
import sqlite3
from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import RebateSettlement
from app.finance import cashflows, rebates, router as finance_router, schemas
from app.reporting import service as reporting_service

TODAY = date(2026, 10, 17)


def _admin() -> CurrentUser:
    # owner_scope=ALL 且显式授权 pool 1：任何 can_see_pool 判定都为可见。
    return CurrentUser(
        id=1, username="admin", roles=(), owner_scope="ALL", pool_ids=frozenset({1})
    )


def _order_with_buy(seeded_db):
    from app.stocks import service as stocks_service
    from app.orders import service as orders_service

    account = stocks_service.create_account(
        seeded_db, game_account="task5-account", business_mode="SELF",
        inventory_type="RECOVERY", actor="pytest",
    )
    order = orders_service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id,
    )
    orders_service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
        occurred_on=TODAY, actor="pytest", pool_id=1,
    )
    return order.id


# ----------------------------------------------------------- cashflows.py:261
def test_reject_cashflow_merges_form_extra(seeded_db):
    flow = cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY, direction="OUT",
        nature="BUSINESS_OUT", category="OTHER", amount=Decimal("10"), actor="pytest",
    )
    rejected = cashflows.reject_cashflow(
        seeded_db, flow.id, actor="pytest", reason="不合理",
        form_extra={"studio_rej": "备注"},
    )
    assert rejected.status == "REJECTED"
    assert rejected.form_extra.get("studio_rej") == "备注"


# ----------------------------------------------------------- cashflows.py:509
def test_cancel_deposit_unknown_raises(seeded_db):
    with pytest.raises(NotFound, match="押金.*不存在"):
        cashflows.cancel_deposit(
            seeded_db, 999999, cancelled_on=TODAY, reason="x", actor="pytest",
        )


# ----------------------------------------------------------- rebates.py:179 / 182
def test_rebate_base_from_snapshot_empty(seeded_db):
    assert rebates._rebate_base_from_snapshot(seeded_db, None, None) is None  # 179


def test_rebate_base_from_snapshot_config_not_dict(seeded_db):
    assert rebates._rebate_base_from_snapshot(seeded_db, {"config": "x"}, None) is None  # 182


# ----------------------------------------------------------- rebates.py:645
def test_void_rebate_rejects_with_settlement(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db), rebate_type="BUY",
        base_amount=Decimal("1000"), rate=Decimal("5"), collected_on=TODAY, actor="pytest",
    )
    # 直接插入结算流水（不走 settle_rebate，避免改写 record.status），
    # 使 record 仍为 OPEN 但 settled_net_total != 0 -> 命中 645 拒绝分支。
    settle = RebateSettlement(
        rebate_record_id=record.id, settled_on=TODAY, settlement_no="VOID-X",
        gross_amount=Decimal("10"), platform_fee=Decimal("0"), net_amount=Decimal("10"),
        cashflow_id=None, created_by="pytest", updated_by="pytest",
    )
    seeded_db.add(settle)
    seeded_db.flush()
    with pytest.raises(Validation, match="返点存在有效结算流水"):
        rebates.void_rebate(seeded_db, record.id, reason="x", actor="pytest")


# ----------------------------------------------------------- rebates.py:429 / 463
# 这两行是 cashflow_id / fee_cashflow_id 指向不存在现金流的防御分支。
# 运行时测试库 FK 开启，ORM 不能直接插悬空引用 -> 用独立原生 sqlite3 连接绕过。
def _corrupt_settlement_fk(seeded_db, settlement_id: int, column: str, bad_id: int) -> None:
    db_path = seeded_db.get_bind().engine.url.database
    seeded_db.commit()  # 先释放 SQLite 写锁
    raw = sqlite3.connect(db_path)
    try:
        raw.execute("PRAGMA foreign_keys=OFF")
        raw.execute(
            f"UPDATE rebate_settlements SET {column} = ? WHERE id = ?",
            (bad_id, settlement_id),
        )
        raw.commit()
    finally:
        raw.close()
    seeded_db.expire_all()  # 让主会话重载（否则 identity map 返回旧对象）


def _make_settlement(seeded_db, *, record_id, flow_id, fee_id):
    settle = RebateSettlement(
        rebate_record_id=record_id, settled_on=TODAY, settlement_no="DANG",
        gross_amount=Decimal("10"), platform_fee=Decimal("0"), net_amount=Decimal("10"),
        cashflow_id=flow_id, fee_cashflow_id=fee_id,
        created_by="pytest", updated_by="pytest",
    )
    seeded_db.add(settle)
    seeded_db.flush()
    return settle


def test_reverse_settlement_missing_cashflow_row(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db), rebate_type="BUY",
        base_amount=Decimal("1000"), rate=Decimal("5"), collected_on=TODAY, actor="pytest",
    )
    flow = cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY, direction="IN", nature="EXTERNAL_IN",
        category="OTHER", amount=Decimal("10"), actor="pytest", note="测试",
    )
    settle = _make_settlement(seeded_db, record_id=record.id, flow_id=flow.id, fee_id=None)
    _corrupt_settlement_fk(seeded_db, settle.id, "cashflow_id", 999315)
    with pytest.raises(Validation, match="关联的资金流水不存在"):
        rebates.reverse_rebate_settlement(
            seeded_db, record.id, settle.id, reversed_on=TODAY, actor="pytest", reason="x",
        )  # 429


def test_reverse_settlement_missing_fee_cashflow_row(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db), rebate_type="BUY",
        base_amount=Decimal("1000"), rate=Decimal("5"), collected_on=TODAY, actor="pytest",
    )
    flow = cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY, direction="IN", nature="EXTERNAL_IN",
        category="OTHER", amount=Decimal("10"), actor="pytest", note="测试",
    )
    settle = _make_settlement(seeded_db, record_id=record.id, flow_id=flow.id, fee_id=flow.id)
    _corrupt_settlement_fk(seeded_db, settle.id, "fee_cashflow_id", 999316)
    with pytest.raises(Validation, match="手续费关联的资金流水不存在"):
        rebates.reverse_rebate_settlement(
            seeded_db, record.id, settle.id, reversed_on=TODAY, actor="pytest", reason="x",
        )  # 463


# ----------------------------------------------------------- finance/router.py:492-495 / 503
def test_router_cancel_deposit_unknown(seeded_db):
    with pytest.raises(NotFound, match="押金不存在"):
        finance_router.cancel_deposit(
            999999, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
            db=seeded_db, user=_admin(),
        )  # 492-494


def test_router_cancel_deposit_success(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
    )
    out = finance_router.cancel_deposit(
        deposit.id, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
        db=seeded_db, user=_admin(),
    )  # 492-495 + 503
    assert out.id == deposit.id
    assert out.status == "CANCELLED"


# ----------------------------------------------------------- finance/router.py:601 / 604
def test_router_void_rebate_success(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db), rebate_type="BUY",
        base_amount=Decimal("1000"), rate=Decimal("5"), collected_on=TODAY, actor="pytest",
    )
    out = finance_router.void_rebate(
        record.id, schemas.RebateVoid(reason="误录"), db=seeded_db, user=_admin(),
    )  # 601 + 604
    assert out.id == record.id
    assert out.status == "VOID"


# ----------------------------------------------------------- reporting/service.py:130 / 132
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
    # 130：None -> 空字符串
    assert item_row[header.index("note")] == ""
    # 132：dict / list -> JSON 序列化
    assert item_row[header.index("meta")] == '{"k": 1}'
    assert item_row[header.index("tags")] == "[1, 2]"


# ----------------------------------------------------------- reporting/service.py:801
def test_daily_funds_report_aggregates_deposit(seeded_db):
    # 801：daily_funds_report 的押金缴纳按池聚合分支，需存在 paid_on==target 的押金才执行。
    cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("50"), paid_on=TODAY, actor="pytest",
    )
    report = reporting_service.daily_funds_report(seeded_db, on=TODAY)
    assert any(Decimal(str(it["deposit_paid"])) > 0 for it in report["items"])
