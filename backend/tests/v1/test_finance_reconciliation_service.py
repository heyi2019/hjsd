from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.finance import pool_accounts
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
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    account = pool_accounts.create_pool_account(
        seeded_db,
        pool_id=pool.id,
        account_no="RECON-SVC-001",
        account_name="对账svc",
        account_type="BANK",
        ownership="OWNED",
        opening_balance=Decimal("50"),
        actor="pytest",
    )
    flow = create_cashflow(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
        occurred_on=date(2026, 10, 17),
        direction="IN",
        nature="BUSINESS_IN",
        fund_nature="BUSINESS",
        accounting_attribute="OPERATING_EXPENSE",
        category="OTHER",
        amount=Decimal("20"),
        actor="pytest",
    )
    approve_cashflow(seeded_db, flow.id, actor="finance")
    return pool, account


def test_create_reconciliation_rejects_duplicate(seeded_db):
    pool, account = _seed_recon(seeded_db)
    create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
        reconciled_on=date(2026, 10, 17),
        account_label="对账svc",
        statement_balance=Decimal("70"),
        actor="pytest",
    )
    with pytest.raises(Validation, match="同一资金池、日期和账户只能对账一次"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=account.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
        )


def test_create_reconciliation_rejects_non_iterable_unmatched(seeded_db):
    pool, account = _seed_recon(seeded_db)
    with pytest.raises(Validation, match="未达流水 ID 列表格式无效"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=account.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=123,
        )


def test_create_reconciliation_rejects_duplicate_flow_ids(seeded_db):
    pool, account = _seed_recon(seeded_db)
    with pytest.raises(Validation, match="未达流水不能重复"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=account.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=[1, 1],
        )


def test_create_reconciliation_rejects_missing_flow(seeded_db):
    pool, account = _seed_recon(seeded_db)
    with pytest.raises(Validation, match="未达流水不存在"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=account.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=[999999],
        )


def test_create_reconciliation_rejects_flow_outside_pool(seeded_db):
    pool, account = _seed_recon(seeded_db)
    profit = pool_accounts.get_pool(seeded_db, "HJ_PROFIT")
    acc2 = pool_accounts.create_pool_account(
        seeded_db,
        pool_id=profit.id,
        account_no="RECON-SVC-002",
        account_name="x",
        account_type="BANK",
        ownership="OWNED",
        opening_balance=Decimal("0"),
        actor="pytest",
    )
    flow2 = create_cashflow(
        seeded_db,
        pool_id=profit.id,
        pool_account_id=acc2.id,
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
            pool_account_id=account.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
            unmatched_flow_ids=[flow2.id],
        )


def test_create_reconciliation_rejects_account_not_in_pool(seeded_db):
    pool, account = _seed_recon(seeded_db)
    profit = pool_accounts.get_pool(seeded_db, "HJ_PROFIT")
    acc2 = pool_accounts.create_pool_account(
        seeded_db,
        pool_id=profit.id,
        account_no="RECON-SVC-003",
        account_name="x",
        account_type="BANK",
        ownership="OWNED",
        opening_balance=Decimal("0"),
        actor="pytest",
    )
    with pytest.raises(Validation, match="对账账户不属于当前资金池"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=acc2.id,
            reconciled_on=date(2026, 10, 17),
            account_label="对账svc",
            statement_balance=Decimal("70"),
            actor="pytest",
        )


def test_create_reconciliation_with_difference_and_reason(seeded_db):
    pool, account = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
        reconciled_on=date(2026, 10, 17),
        account_label="差异对账",
        statement_balance=Decimal("100"),
        actor="pytest",
        reason="差异说明",
    )
    assert item.difference == Decimal("30")
    assert item.status == "OPEN"
    assert item.reason == "差异说明"


def test_create_reconciliation_rejects_user_not_visible(seeded_db):
    pool, account = _seed_recon(seeded_db)
    with pytest.raises(NotFound, match="资金池不存在"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=account.id,
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
    pool, account = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
        reconciled_on=date(2026, 10, 17),
        account_label="可见测试",
        statement_balance=Decimal("70"),
        actor="pytest",
    )
    with pytest.raises(NotFound):
        _get_reconciliation(seeded_db, item.id, user=_restricted_user())


def test_list_reconciliations_user_filter(seeded_db):
    pool, account = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
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
    pool, account = _seed_recon(seeded_db)
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
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
    pool, account = _seed_recon(seeded_db)
    # system=70 而 statement=100 → difference=30（!=0），且不传 reason；
    # 删除原 153 行冗余防御后，此行为改由 _text(required=difference!=0) 兜住。
    with pytest.raises(Validation, match="存在差异时必须填写差异原因"):
        create_reconciliation(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=account.id,
            reconciled_on=date(2026, 10, 17),
            account_label="差异无原因",
            statement_balance=Decimal("100"),
            actor="pytest",
        )
