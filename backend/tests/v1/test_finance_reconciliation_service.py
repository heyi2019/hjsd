from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.foundation import Pool
from app.finance.cashflows import approve_cashflow, create_cashflow
from app.finance.reconciliation import (
    _get_reconciliation,
    create_reconciliation,
    list_reconciliations,
    resolve_reconciliation,
)


def _restricted_user() -> CurrentUser:
    return CurrentUser(
        id=999,
        username="restricted",
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset(),
        owner_scope="SELF",
    )


def _seed_recon(seeded_db):
    """在 HJ_INVEST 池上造两笔已审核流水，建立系统余额基线 50+20=70。

    资金池账户下线后系统余额即「池内已审核流水有符号和」，原本来自
    PoolAccount.opening_balance 的 50 改为等额期初流水，基线保持不变。
    """
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None, "种子池 HJ_INVEST 缺失"
    for amount in (Decimal("50"), Decimal("20")):
        flow = create_cashflow(
            seeded_db,
            pool_id=pool.id,
            occurred_on=date(2026, 10, 17),
            direction="IN",
            nature="BUSINESS_IN",
            fund_nature="BUSINESS",
            accounting_attribute="OPERATING_EXPENSE",
            category="OTHER",
            amount=amount,
            actor="pytest",
        )
        approve_cashflow(seeded_db, flow.id, actor="finance")
    return pool


def test_create_reconciliation_rejects_duplicate(seeded_db):
    pool = _seed_recon(seeded_db)
    create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 17),
        account_label="对账svc",
        statement_balance=Decimal("70"),
        actor="pytest",
    )
    with pytest.raises(Validation, match="同一资金池、日期和账户只能对账一次"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
        )


def test_create_reconciliation_rejects_non_iterable_unmatched(seeded_db):
    pool = _seed_recon(seeded_db)
    with pytest.raises(Validation, match="未达流水 ID 列表格式无效"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=123,
        )


def test_create_reconciliation_rejects_duplicate_flow_ids(seeded_db):
    pool = _seed_recon(seeded_db)
    with pytest.raises(Validation, match="未达流水不能重复"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=[1, 1],
        )


def test_create_reconciliation_rejects_missing_flow(seeded_db):
    pool = _seed_recon(seeded_db)
    with pytest.raises(Validation, match="未达流水不存在"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=[999999],
        )


def test_create_reconciliation_rejects_flow_outside_pool(seeded_db):
    pool = _seed_recon(seeded_db)
    profit = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT"))
    flow2 = create_cashflow(
        seeded_db,
        pool_id=profit.id,
        occurred_on=date(2026, 10, 17),
        direction="IN",
        nature="BUSINESS_IN",
        fund_nature="BUSINESS",
        accounting_attribute="OPERATING_EXPENSE",
        category="OTHER",
        amount=Decimal("5"),
        actor="pytest",
    )
    approve_cashflow(seeded_db, flow2.id, actor="finance")
    with pytest.raises(Validation, match="未达流水必须属于当前资金池且不晚于对账日"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=[flow2.id],
        )


def test_create_reconciliation_with_difference_and_reason(seeded_db):
    pool = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 17),
        account_label="差异对账",
        statement_balance=Decimal("100"),
        actor="pytest",
        reason="差异说明",
    )
    assert item.difference == Decimal("30")
    assert item.status == "OPEN"
    assert item.reason == "差异说明"


def test_create_reconciliation_survives_decimal_balances(seeded_db):
    """P1-01 回归：小数余额对账不再被 CHECK 浮点残差 IntegrityError 打爆。

    严格等式 `difference = statement_balance - system_balance` 下，SQLite 按
    REAL 求值，0.30-0.10=0.19999999999999929 ≠ 0.20 必炸（实测 5 组常见金额
    3 组 500）。CHECK 改容差 <=0.005（半分）后以下组合都应正常落库。
    """
    pool = _seed_recon(seeded_db)
    # 系统余额再加一笔 0.10 → 70.10（system_balance 带角分，最贴近真实流水）
    flow = create_cashflow(
        seeded_db,
        pool_id=pool.id,
        occurred_on=date(2026, 10, 17),
        direction="IN",
        nature="BUSINESS_IN",
        fund_nature="BUSINESS",
        accounting_attribute="OPERATING_EXPENSE",
        category="OTHER",
        amount=Decimal("0.10"),
        actor="pytest",
    )
    approve_cashflow(seeded_db, flow.id, actor="finance")

    # 组合一：70.30 - 70.10，严格等式下 70.30-70.10=0.19999999999999929 必炸
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 18),
        account_label="小数对账-系统带角分",
        statement_balance=Decimal("70.30"),
        actor="pytest",
        reason="银行手续费",
    )
    assert item.system_balance == Decimal("70.10")
    assert item.difference == Decimal("0.20")

    # 组合二：负差异（70.00-70.10=-0.10000000000000142 严格等式下必炸）
    item2 = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 19),
        account_label="小数对账-报表带角分",
        statement_balance=Decimal("70.00"),
        actor="pytest",
        reason="在途利息",
    )
    assert item2.difference == Decimal("-0.10")

    # 组合三：两余额相等但均带角分（差 0，严格等式下 x-x=0 本就精确，兜底验证）
    item3 = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 20),
        account_label="小数对账-零差异",
        statement_balance=Decimal("70.10"),
        actor="pytest",
    )
    assert item3.difference == Decimal("0")


def test_create_reconciliation_rejects_user_not_visible(seeded_db):
    pool = _seed_recon(seeded_db)
    with pytest.raises(NotFound, match="资金池不存在"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            reconciled_on=date(2026, 10, 17),
            account_label="x",
            statement_balance=Decimal("0"),
            actor="pytest",
            user=_restricted_user(),
        )


def test_get_reconciliation_rejects_unknown(seeded_db):
    with pytest.raises(NotFound):
        _get_reconciliation(seeded_db, 999999)


def test_get_reconciliation_rejects_user_not_visible(seeded_db):
    pool = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 17),
        account_label="可见测试",
        statement_balance=Decimal("70"),
        actor="pytest",
    )
    with pytest.raises(NotFound):
        _get_reconciliation(seeded_db, item.id, user=_restricted_user())


def test_list_reconciliations_user_filter(seeded_db):
    pool = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 17),
        account_label="list测试",
        statement_balance=Decimal("70"),
        actor="pytest",
    )
    user = _restricted_user()
    # pool_id 指定但用户不可见 → 空
    assert list_reconciliations(seeded_db, pool_id=pool.id, user=user) == []
    # 仅传 user（非 admin，pool_ids 空）→ 空
    assert list_reconciliations(seeded_db, user=user) == []
    # pool_ids 指定但用户不可见 → 空
    assert list_reconciliations(seeded_db, pool_ids=[pool.id], user=user) == []
    # 无 user 正常返回含 item
    assert any(r.id == item.id for r in list_reconciliations(seeded_db, pool_id=pool.id))


def test_resolve_reconciliation_requires_open_and_reason(seeded_db):
    pool = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        reconciled_on=date(2026, 10, 17),
        account_label="核销测试",
        statement_balance=Decimal("70"),
        actor="pytest",
    )
    resolved = resolve_reconciliation(seeded_db, item.id, actor="pytest", reason="已处理")
    assert resolved.status == "RESOLVED"
    # 重复核销 → 已核销
    with pytest.raises(Validation, match="该对账记录已核销"):
        resolve_reconciliation(seeded_db, item.id, actor="pytest", reason="再次")


def test_create_reconciliation_rejects_difference_without_reason(seeded_db):
    pool = _seed_recon(seeded_db)
    # system=70 而 statement=100 → difference=30（!=0），且不传 reason；
    # 删除原 153 行冗余防御后，此行为改由 _text(required=difference!=0) 兜住。
    with pytest.raises(Validation, match="存在差异时必须填写差异原因"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            reconciled_on=date(2026, 10, 17),
            account_label="差异无原因",
            statement_balance=Decimal("100"),
            actor="pytest",
        )
