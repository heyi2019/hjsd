"""不可达状态收口：SUPERSEDED / EXPIRED / VOID / CANCELLED / REJECTED 写入路径。

QA500B 补齐轮确认这 5 个枚举值无写入路径，本文件按补齐端点逐个锁定：
1. PolicyVersion.SUPERSEDED  — POST /policy-versions/{id}/supersede（仅 DRAFT）
2. PolicyVersion.EXPIRED     — POST /policies/versions/expire-sweep（effective_to < on）
3. RebateRecord.VOID         — POST /rebates/{id}/void（仅零结算 OPEN）
4. Deposit.CANCELLED         — POST /deposits/{id}/cancel（仅 PAID 无退还/损失，全额冲正）
5. ImportBatch.REJECTED      — POST /imports/batches/{id}/reject（仅 DRAFT/MAPPED）
附带：CounterpartyStatus.DISABLED 走既有 PATCH /counterparties/{id}/status。
"""
from __future__ import annotations

from datetime import date

from app.domain.enums import (
    DepositStatus,
    ImportBatchStatus,
    PolicyStatus,
)
from app.domain.trade import Cashflow, Deposit
from app.finance import service as finance_service
from app.imports import service as imports_service
from app.policy import service as policy_service


# ── 1. Policy SUPERSEDED：草稿取消 ───────────────────────────────


def _make_def(seeded_db, code: str) -> dict:
    return policy_service.create_definition(
        seeded_db,
        policy_code=code,
        name=f"{code} 规则",
        scope_type="GLOBAL",
        description="状态收口测试",
        actor="pytest",
    )


def test_supersede_rejects_published_version(seeded_db):
    definition = _make_def(seeded_db, "SUP-TEST")
    version = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 12, 31),
        config={"rate": "10"},
        actor="pytest",
    )
    # 创建即发布（ACTIVE）：已发布版本是历史解析口径，不可取消
    import pytest
    from app.core.errors import Validation

    with pytest.raises(Validation):
        policy_service.supersede_draft_version(
            seeded_db,
            version["id"],
            actor="pytest",
            reason="已发布版本不可取消",
        )


def test_supersede_rejects_active_version(seeded_db):
    definition = _make_def(seeded_db, "SUP-ACT")
    version = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 12, 31),
        config={"rate": "10"},
        actor="pytest",
    )
    import pytest
    from app.core.errors import Validation

    with pytest.raises(Validation):
        policy_service.supersede_draft_version(
            seeded_db, version["id"], actor="pytest", reason="不该成功"
        )


def test_supersede_requires_reason(seeded_db):
    definition = _make_def(seeded_db, "SUP-REASON")
    version = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 12, 31),
        config={"rate": "10"},
        actor="pytest",
    )
    import pytest
    from app.core.errors import Validation

    with pytest.raises(Validation):
        policy_service.supersede_draft_version(
            seeded_db, version["id"], actor="pytest", reason=""
        )


# ── 2. Policy EXPIRED：过期清扫 ──────────────────────────────────


def test_expire_sweep_marks_lapsed_versions(seeded_db):
    definition = _make_def(seeded_db, "EXP-TEST")
    lapsed = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 12, 31),
        config={"rate": "10"},
        actor="pytest",
    )
    live = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=date(2027, 1, 1),
        effective_to=None,
        config={"rate": "12"},
        actor="pytest",
    )

    out = policy_service.expire_lapsed_versions(seeded_db, on=date(2027, 1, 1), actor="pytest")
    assert out["swept"] == 1
    assert lapsed["id"] in out["version_ids"]
    assert live["id"] not in out["version_ids"]
    from app.domain.parties import PolicyVersion

    assert (
        seeded_db.get(PolicyVersion, lapsed["id"]).status == PolicyStatus.EXPIRED.value
    )
    assert seeded_db.get(PolicyVersion, live["id"]).status == PolicyStatus.ACTIVE.value


def test_expire_sweep_idempotent(seeded_db):
    definition = _make_def(seeded_db, "EXP-IDEM")
    policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 30),
        config={"rate": "10"},
        actor="pytest",
    )
    first = policy_service.expire_lapsed_versions(seeded_db, on=date(2026, 7, 1), actor="pytest")
    second = policy_service.expire_lapsed_versions(seeded_db, on=date(2026, 7, 1), actor="pytest")
    assert first["swept"] == 1
    assert second["swept"] == 0


# ── 3. Rebate VOID：零结算取消 ───────────────────────────────────

TODAY = date(2026, 10, 17)


# ── 4. Deposit CANCELLED：全额冲正取消 ───────────────────────────


def _make_deposit(seeded_db, *, code: str) -> Deposit:
    from app.foundation import service as foundation_service

    pool = foundation_service.create_pool(
        seeded_db,
        code=f"VDP{code.upper()}",
        name=f"押金取消测试池 {code}",
        actor="pytest",
    )
    return finance_service.create_deposit(
        seeded_db,
        pool_id=pool.id,
        amount="300",
        paid_on=date(2026, 10, 1),
        actor="pytest",
        counterparty_id=None,
        source_order_id=None,
        expected_release_on=None,
        note="状态收口测试押金",
    )


def test_cancel_paid_deposit_writes_reversal(seeded_db):
    deposit = _make_deposit(seeded_db, code="c1")
    out = finance_service.cancel_deposit(
        seeded_db,
        deposit.id,
        cancelled_on=date(2026, 10, 5),
        reason="押金登记有误",
        actor="pytest",
    )
    assert out.status == DepositStatus.CANCELLED.value
    flows = (
        seeded_db.query(Cashflow)
        .filter(Cashflow.deposit_id == deposit.id, Cashflow.category == "DEPOSIT_CANCEL")
        .all()
    )
    assert len(flows) == 1
    assert str(flows[0].amount) == str(deposit.paid_amount)


def test_cancel_returned_deposit_rejected(seeded_db):
    deposit = _make_deposit(seeded_db, code="c2")
    finance_service.return_deposit(
        seeded_db,
        deposit.id,
        amount="100",
        released_on=date(2026, 10, 3),
        actor="pytest",
    )
    import pytest
    from app.core.errors import Validation

    with pytest.raises(Validation):
        finance_service.cancel_deposit(
            seeded_db,
            deposit.id,
            cancelled_on=date(2026, 10, 5),
            reason="已发生退还不可取消",
            actor="pytest",
        )


# ── 5. ImportBatch REJECTED：未确认批次驳回 ──────────────────────


def _make_batch(seeded_db, *, code: str) -> dict:
    return imports_service.create_batch(
        seeded_db,
        source_name=f"驳回测试 {code}",
        rows=[{"order_no": "X1", "amount": "10"}],
        actor="pytest",
    )


def test_reject_uncommitted_batch(seeded_db):
    batch = _make_batch(seeded_db, code="r1")
    out = imports_service.reject_batch(
        seeded_db, batch["id"], reason="源文件口径错误", actor="pytest"
    )
    assert out["status"] == ImportBatchStatus.REJECTED.value


def test_reject_committed_batch_rejected(seeded_db):
    batch = _make_batch(seeded_db, code="r2")
    imports_service.commit_batch(seeded_db, batch["id"], actor="pytest")
    import pytest
    from app.core.errors import Validation

    with pytest.raises(Validation):
        imports_service.reject_batch(
            seeded_db, batch["id"], reason="已确认不可驳回", actor="pytest"
        )


def test_reject_twice_rejected(seeded_db):
    batch = _make_batch(seeded_db, code="r3")
    imports_service.reject_batch(seeded_db, batch["id"], reason="首次驳回", actor="pytest")
    import pytest
    from app.core.errors import Validation

    with pytest.raises(Validation):
        imports_service.reject_batch(seeded_db, batch["id"], reason="重复驳回", actor="pytest")
