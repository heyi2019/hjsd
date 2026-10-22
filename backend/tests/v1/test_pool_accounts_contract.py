from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import Conflict, NotFound, Validation
from app.finance import pool_accounts


def test_pool_account_create_and_list(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    account = pool_accounts.create_pool_account(
        seeded_db,
        pool_id=pool.id,
        account_no="BANK-001",
        account_name="经营主账户",
        account_type="BANK",
        ownership="OWNED",
        opening_balance=Decimal("100.00"),
        actor="pytest",
    )
    assert account.account_no == "BANK-001"
    assert account.opening_balance == Decimal("100.00")
    assert pool_accounts.pool_account_balance(seeded_db, account) == Decimal("100.00")
    from app.finance.cashflows import approve_cashflow, create_cashflow
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
        amount=Decimal("25.00"),
        actor="pytest",
        note="账户余额测试",
    )
    approve_cashflow(seeded_db, flow.id, actor="finance")
    assert pool_accounts.pool_account_balance(seeded_db, account) == Decimal("125.00")
    outflow = create_cashflow(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
        occurred_on=date(2026, 10, 17),
        direction="OUT",
        nature="BUSINESS_OUT",
        fund_nature="BUSINESS",
        accounting_attribute="OPERATING_EXPENSE",
        category="OTHER",
        amount=Decimal("5.00"),
        actor="pytest",
        note="账户余额支出测试",
    )
    approve_cashflow(seeded_db, outflow.id, actor="finance")
    assert pool_accounts.pool_account_balance(seeded_db, account) == Decimal("120.00")
    assert pool_accounts.list_pool_accounts(seeded_db, pool_id=pool.id)[0].id == account.id


def test_pool_account_rejects_invalid_ownership(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    with pytest.raises(Validation, match="账户归属无效"):
        pool_accounts.create_pool_account(
            seeded_db,
            pool_id=pool.id,
            account_no="BANK-INVALID",
            account_name="错误账户",
            account_type="BANK",
            ownership="INVALID",
            opening_balance=Decimal("0"),
            actor="pytest",
        )


def test_pool_account_api_create_list_and_disable(client, headers, seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    created = client.post(
        "/api/v1/pool-accounts",
        headers=headers,
        json={
            "pool_id": pool.id,
            "account_no": "API-BANK-001",
            "account_name": "接口账户",
            "account_type": "BANK",
            "ownership": "OWNED",
            "opening_balance": "10.00",
        },
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
    listed = client.get("/api/v1/pool-accounts", headers=headers)
    assert listed.status_code == 200
    assert any(item["id"] == account_id for item in listed.json())
    disabled = client.patch(
        f"/api/v1/pool-accounts/{account_id}/status?status=DISABLED", headers=headers
    )
    assert disabled.status_code == 200
    assert disabled.json()["status"] == "DISABLED"


def test_pool_account_api_update_profile(client, headers, seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    created = client.post(
        "/api/v1/pool-accounts",
        headers=headers,
        json={
            "pool_id": pool.id,
            "account_no": "API-EDIT-001",
            "account_name": "待编辑账户",
            "account_type": "BANK",
            "ownership": "OWNED",
            "opening_balance": "10.00",
        },
    )
    assert created.status_code == 201, created.text

    updated = client.patch(
        f"/api/v1/pool-accounts/{created.json()['id']}",
        headers=headers,
        json={
            "account_name": "已编辑账户",
            "account_type": "CASH",
            "ownership": "CUSTODY",
            "opening_balance": "12.00",
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["account_no"] == "API-EDIT-001"
    assert updated.json()["account_name"] == "已编辑账户"
    assert updated.json()["account_type"] == "CASH"
    assert updated.json()["ownership"] == "CUSTODY"
    assert updated.json()["opening_balance"] == "12.00"


def test_pool_account_reconciliation_scopes_balance_and_list_filter(seeded_db):
    from app.finance.cashflows import approve_cashflow, create_cashflow
    from app.finance.reconciliation import create_reconciliation, list_reconciliations

    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    account = pool_accounts.create_pool_account(
        seeded_db,
        pool_id=pool.id,
        account_no="RECON-BANK-001",
        account_name="对账账户",
        account_type="BANK",
        ownership="OWNED",
        opening_balance=Decimal("50.00"),
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
        amount=Decimal("20.00"),
        actor="pytest",
    )
    approve_cashflow(seeded_db, flow.id, actor="finance")
    item = create_reconciliation(
        seeded_db,
        pool_id=pool.id,
        pool_account_id=account.id,
        reconciled_on=date(2026, 10, 17),
        account_label="对账账户",
        statement_balance=Decimal("70.00"),
        actor="pytest",
    )
    assert item.system_balance == Decimal("70.00")
    assert item.pool_account_id == account.id
    assert list_reconciliations(seeded_db, pool_account_id=account.id)[0].id == item.id


def test_pool_account_batch_status_is_atomic_and_audited(client, headers, seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    first = pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="BATCH-001", account_name="批量一",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="pytest",
    )
    second = pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="BATCH-002", account_name="批量二",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="pytest",
    )
    response = client.post(
        "/api/v1/pool-accounts/batch-status",
        headers=headers,
        json={"account_ids": [first.id, second.id], "status": "DISABLED", "reason": "月末批量停用"},
    )
    assert response.status_code == 200, response.text
    assert {item["status"] for item in response.json()} == {"DISABLED"}

    invalid = client.post(
        "/api/v1/pool-accounts/batch-status",
        headers=headers,
        json={"account_ids": [first.id, 99999999], "status": "ACTIVE", "reason": "回滚验证"},
    )
    assert invalid.status_code == 404
    seeded_db.expire_all()
    assert seeded_db.get(type(first), first.id).status == "DISABLED"


def test_get_pool_rejects_unknown_code(seeded_db):
    with pytest.raises(NotFound):
        pool_accounts.get_pool(seeded_db, "NO_SUCH_POOL")


def test_create_pool_account_rejects_unknown_pool(seeded_db):
    with pytest.raises(NotFound, match="资金池不存在"):
        pool_accounts.create_pool_account(
            seeded_db, pool_id=999999, account_no="X1", account_name="x",
            account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
        )


def test_create_pool_account_rejects_disabled_pool(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    pool.status = "DISABLED"
    seeded_db.flush()
    try:
        with pytest.raises(Validation, match="停用资金池不能新增账户"):
            pool_accounts.create_pool_account(
                seeded_db, pool_id=pool.id, account_no="DIS-001", account_name="x",
                account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
            )
    finally:
        pool.status = "ACTIVE"
        seeded_db.flush()


def test_create_pool_account_rejects_blank_name(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    with pytest.raises(Validation, match="账户编号和名称必填"):
        pool_accounts.create_pool_account(
            seeded_db, pool_id=pool.id, account_no="", account_name="",
            account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
        )


def test_create_pool_account_rejects_invalid_type(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    with pytest.raises(Validation, match="账户类型无效"):
        pool_accounts.create_pool_account(
            seeded_db, pool_id=pool.id, account_no="T1", account_name="x",
            account_type="ZZ", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
        )


def test_create_pool_account_rejects_duplicate_no(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="DUP-001", account_name="x",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
    )
    with pytest.raises(Conflict, match="账户编号已存在"):
        pool_accounts.create_pool_account(
            seeded_db, pool_id=pool.id, account_no="DUP-001", account_name="y",
            account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
        )


def test_create_pool_account_rejects_negative_balance(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    with pytest.raises(Validation, match="期初余额不能为负数"):
        pool_accounts.create_pool_account(
            seeded_db, pool_id=pool.id, account_no="NEG-001", account_name="x",
            account_type="BANK", ownership="OWNED", opening_balance=Decimal("-1"), actor="t",
        )


def test_update_pool_account_rejects_unknown(seeded_db):
    with pytest.raises(NotFound, match="资金账户不存在"):
        pool_accounts.update_pool_account(seeded_db, 999999, account_name="x", actor="t")


def test_update_pool_account_rejects_blank_name(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    acc = pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="UP-001", account_name="原",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
    )
    with pytest.raises(Validation, match="账户名称不能为空"):
        pool_accounts.update_pool_account(seeded_db, acc.id, account_name="  ", actor="t")


def test_update_pool_account_rejects_invalid_type_and_ownership(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    acc = pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="UP-002", account_name="原",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
    )
    with pytest.raises(Validation, match="账户类型无效"):
        pool_accounts.update_pool_account(seeded_db, acc.id, account_type="ZZ", actor="t")
    with pytest.raises(Validation, match="账户归属无效"):
        pool_accounts.update_pool_account(seeded_db, acc.id, ownership="ZZ", actor="t")


def test_update_pool_account_sets_note(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    acc = pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="UP-003", account_name="原",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
    )
    updated = pool_accounts.update_pool_account(seeded_db, acc.id, note="备注", actor="t")
    assert updated.note == "备注"


def test_set_pool_account_status_rejects_invalid(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    acc = pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="ST-001", account_name="x",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
    )
    with pytest.raises(Validation, match="账户状态无效"):
        pool_accounts.set_pool_account_status(seeded_db, acc.id, status="ZZ", actor="t")


def test_set_pool_account_status_rejects_unknown(seeded_db):
    with pytest.raises(NotFound, match="资金账户不存在"):
        pool_accounts.set_pool_account_status(seeded_db, 999999, status="DISABLED", actor="t")


def test_batch_set_pool_account_status_validation(seeded_db):
    pool = pool_accounts.get_pool(seeded_db, "HJ_INVEST")
    acc = pool_accounts.create_pool_account(
        seeded_db, pool_id=pool.id, account_no="BVAL-001", account_name="x",
        account_type="BANK", ownership="OWNED", opening_balance=Decimal("0"), actor="t",
    )
    with pytest.raises(Validation, match="账户状态无效"):
        pool_accounts.batch_set_pool_account_status(
            seeded_db, [acc.id], status="ZZ", reason="r", actor="t")
    with pytest.raises(Validation, match="账户 ID 必须为 1-100 个且不能重复"):
        pool_accounts.batch_set_pool_account_status(
            seeded_db, [acc.id, acc.id], status="DISABLED", reason="r", actor="t")
    with pytest.raises(Validation, match="批量变更必须填写原因"):
        pool_accounts.batch_set_pool_account_status(
            seeded_db, [acc.id], status="DISABLED", reason="  ", actor="t")
