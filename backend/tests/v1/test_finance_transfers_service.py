from datetime import date
from decimal import Decimal

import pytest

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.finance import transfers


def _pools(seeded_db):
    from app.finance import pool_accounts

    return (
        pool_accounts.get_pool(seeded_db, "HJ_INVEST"),
        pool_accounts.get_pool(seeded_db, "HJ_PROFIT"),
    )


def _make_single_side(seeded_db, *, source, target):
    """造一笔完整池间划转后删除 target 边，留下 source 单边记录。"""
    result = transfers.create_transfer(
        seeded_db,
        source_pool_id=source.id,
        target_pool_id=target.id,
        amount=Decimal("10"),
        occurred_on=date(2026, 10, 17),
        actor="pytest",
    )
    in_flow = result["cashflows"][1]
    seeded_db.delete(in_flow)
    seeded_db.flush()
    return result["transfer_id"]


def test_create_transfer_rejects_same_pool(seeded_db):
    invest, _ = _pools(seeded_db)
    with pytest.raises(Validation, match="转出池与转入池不能相同"):
        transfers.create_transfer(
            seeded_db,
            source_pool_id=invest.id,
            target_pool_id=invest.id,
            amount=Decimal("10"),
            occurred_on=date(2026, 10, 17),
            actor="pytest",
        )


def test_repair_transfer_rejects_unknown(seeded_db):
    with pytest.raises(NotFound, match="划转 .* 不存在"):
        transfers.repair_transfer(
            seeded_db,
            "TRF-NOWHERE",
            counterpart_pool_id=1,
            actor="pytest",
            reason="r",
        )


def test_repair_transfer_rejects_same_counterpart_pool(seeded_db):
    invest, profit = _pools(seeded_db)
    tid = _make_single_side(seeded_db, source=invest, target=profit)
    with pytest.raises(Validation, match="修复对端资金池不能与原资金池相同"):
        transfers.repair_transfer(
            seeded_db,
            tid,
            counterpart_pool_id=invest.id,
            actor="pytest",
            reason="r",
        )


def test_repair_transfer_completes_single_side(seeded_db):
    invest, profit = _pools(seeded_db)
    tid = _make_single_side(seeded_db, source=invest, target=profit)
    repaired = transfers.repair_transfer(
        seeded_db,
        tid,
        counterpart_pool_id=profit.id,
        actor="pytest",
        reason="补回缺失边",
    )
    assert repaired["transfer_id"] == tid
    assert len(repaired["cashflows"]) == 2


def test_repair_transfer_rejects_pool_not_visible_to_user(seeded_db):
    invest, profit = _pools(seeded_db)
    tid = _make_single_side(seeded_db, source=invest, target=profit)
    restricted = CurrentUser(
        id=999,
        username="restricted",
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset(),
        owner_scope="SELF",
    )
    with pytest.raises(NotFound, match="资金池不存在"):
        transfers.repair_transfer(
            seeded_db,
            tid,
            counterpart_pool_id=profit.id,
            actor="pytest",
            reason="r",
            user=restricted,
        )
