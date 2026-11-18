"""TRANSFER-01 资金划转两腿成对，共用 transfer_id。"""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select, text

from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import AccountingAttribute, CashflowSourceType, Direction
from app.domain.foundation import Pool
from app.domain.trade import Cashflow
from app.finance import transfers


def _pools(seeded_db):
    """按 code 取 system 池（等价于原 pool_accounts.get_pool）。"""
    invest = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    profit = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT"))
    assert invest is not None and profit is not None, "种子池缺失"
    return invest, profit


def _seed_available_cash(seeded_db, pool):
    seeded_db.add(
        Cashflow(
            flow_no=f"TEST-IN-{pool.id}",
            pool_id=pool.id,
            occurred_on=date(2026, 10, 16),
            accounting_attribute=AccountingAttribute.SELF_REVENUE.value,
            category="OTHER",
            direction=Direction.IN.value,
            amount=to_money("100.00"),
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.flush()


def _make_single_side(seeded_db, *, source, target):
    """造一笔完整池间划转后删除 target 边，留下 source 单边记录。"""
    _seed_available_cash(seeded_db, source)
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


def test_create_transfer_uses_directional_global_flow_numbers(seeded_db):
    invest, profit = _pools(seeded_db)
    _seed_available_cash(seeded_db, invest)

    result = transfers.create_transfer(
        seeded_db,
        source_pool_id=invest.id,
        target_pool_id=profit.id,
        amount=Decimal("10"),
        occurred_on=date(2026, 10, 17),
        actor="pytest",
    )

    assert result["cashflows"][0].flow_no == "ZC00001"
    assert result["cashflows"][1].flow_no == "SR00001"


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


def test_create_transfer_rejects_amount_above_source_available(seeded_db):
    invest, profit = _pools(seeded_db)

    with pytest.raises(Validation, match="转出资金账户可用余额不足"):
        transfers.create_transfer(
            seeded_db,
            source_pool_id=invest.id,
            target_pool_id=profit.id,
            amount=Decimal("999999999"),
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
    with pytest.raises(Validation, match="修复对端资金账户不能与原资金账户相同"):
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
    with pytest.raises(NotFound, match="资金账户不存在"):
        transfers.repair_transfer(
            seeded_db,
            tid,
            counterpart_pool_id=profit.id,
            actor="pytest",
            reason="r",
            user=restricted,
        )


def test_repair_transfer_completes_in_direction_single_side(seeded_db):
    """单边剩余行为 IN 方向时，补齐的边应为 OUT 方向（覆盖 elif 分支）。"""
    invest, profit = _pools(seeded_db)
    _seed_available_cash(seeded_db, invest)
    result = transfers.create_transfer(
        seeded_db,
        source_pool_id=invest.id,
        target_pool_id=profit.id,
        amount=Decimal("10"),
        occurred_on=date(2026, 10, 17),
        actor="pytest",
    )
    # 删除 OUT 边，只留下 IN 方向的单边记录
    seeded_db.delete(result["cashflows"][0])
    seeded_db.flush()
    repaired = transfers.repair_transfer(
        seeded_db,
        result["transfer_id"],
        counterpart_pool_id=invest.id,
        actor="pytest",
        reason="补回缺失的 OUT 边",
    )
    assert repaired["transfer_id"] == result["transfer_id"]
    assert len(repaired["cashflows"]) == 2
    repaired_flow = repaired["cashflows"][1]
    assert repaired_flow.direction == Direction.OUT.value
    assert repaired_flow.pool_id == invest.id


def test_repair_transfer_rejects_multiple_rows_same_transfer(seeded_db):
    """同一 transfer_id 出现第三行（非 0/1/2 行）应命中 len(rows) != 1 防御分支。"""
    invest, profit = _pools(seeded_db)
    _seed_available_cash(seeded_db, invest)
    result = transfers.create_transfer(
        seeded_db,
        source_pool_id=invest.id,
        target_pool_id=profit.id,
        amount=Decimal("10"),
        occurred_on=date(2026, 10, 17),
        actor="pytest",
    )
    tid = result["transfer_id"]
    third = Cashflow(
        flow_no=f"{tid}-THIRD",
        pool_id=profit.id,
        occurred_on=date(2026, 10, 17),
        direction=Direction.OUT.value,
        amount=to_money("10"),
        source_type=CashflowSourceType.TRANSFER.value,
        source_id=tid,
    )
    seeded_db.add(third)
    seeded_db.flush()
    with pytest.raises(Validation, match="不是单边记录"):
        transfers.repair_transfer(
            seeded_db,
            tid,
            counterpart_pool_id=profit.id,
            actor="pytest",
            reason="r",
        )


def test_repair_transfer_rejects_invalid_direction(seeded_db):
    """单边记录方向既非 IN 也非 OUT（脏数据）应命中 else 防御分支。

    PostgreSQL 没有 SQLite 的 `PRAGMA ignore_check_constraints`，CHECK 也不能像外键
    那样靠 `session_replication_role` 绕开，只能把方向约束摘掉、灌完脏行再戴回。
    戴回会全表校验，所以 finally 里先删脏行再 ADD CONSTRAINT——否则 ADD 自己就失败。
    """
    invest, profit = _pools(seeded_db)
    bad_tid = "TRF-BAD-DIR"
    bad_flow_no = f"{bad_tid}-BAD"
    check_name = "ck_cashflow_cashflow_direction_valid"
    seeded_db.execute(text(f"ALTER TABLE cashflow DROP CONSTRAINT {check_name}"))
    try:
        bad = Cashflow(
            flow_no=bad_flow_no,
            pool_id=invest.id,
            occurred_on=date(2026, 10, 17),
            accounting_attribute=AccountingAttribute.INTERNAL_TRANSFER.value,
            category="TRANSFER",
            direction="ZZ",
            amount=to_money("10"),
            source_type=CashflowSourceType.TRANSFER.value,
            source_id=bad_tid,
        )
        seeded_db.add(bad)
        seeded_db.flush()
        with pytest.raises(Validation, match="单边划转方向无效"):
            transfers.repair_transfer(
                seeded_db,
                bad_tid,
                counterpart_pool_id=profit.id,
                actor="pytest",
                reason="r",
            )
    finally:
        # 先清脏行再加回约束：ADD CONSTRAINT 会全表校验，表里留着 direction='ZZ'
        # 的行会让它直接失败。约束一旦丢不回，后续所有用例都失去这层保护。
        seeded_db.execute(text("DELETE FROM cashflow WHERE flow_no = :flow_no"), {"flow_no": bad_flow_no})
        seeded_db.commit()
        seeded_db.execute(
            text(
                f"ALTER TABLE cashflow ADD CONSTRAINT {check_name} "
                "CHECK (direction IN ('IN', 'OUT'))"
            )
        )
        seeded_db.commit()
