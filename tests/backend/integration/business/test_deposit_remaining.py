"""DEPOSIT-01 押金剩余（DEP-01）：口径与夹底由后端下发。

`DepositOut.remaining_amount` 统一给出剩余金额，本文件锁住：
1. 未退未损时剩余等于实收；
2. 部分退还 + 部分损失按差额算；
3. 退还与损失合计超过实收时按 0 计（不出现负数）；
4. 列表接口确实下发该字段。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.trade import Deposit
from app.finance import service as finance_service

TODAY = date(2026, 10, 4)


def _deposit(seeded_db, amount: str = "500.00") -> Deposit:
    return finance_service.create_deposit(
        seeded_db, pool_id=1, amount=Decimal(amount), paid_on=TODAY, actor="pytest"
    )


def _remaining(seeded_client, headers, deposit_id: int) -> Decimal:
    response = seeded_client.get("/api/v1/deposits", headers=headers)
    assert response.status_code == 200, response.text
    row = next(item for item in response.json() if item["id"] == deposit_id)
    return Decimal(row["remaining_amount"])


def test_remaining_equals_paid_when_untouched(seeded_client, seeded_db, headers):
    deposit = _deposit(seeded_db)
    seeded_db.commit()

    assert _remaining(seeded_client, headers, deposit.id) == Decimal("500.00")


def test_remaining_subtracts_returned_and_lost(seeded_client, seeded_db, headers):
    deposit = _deposit(seeded_db)
    deposit.returned_amount = Decimal("200.00")
    deposit.lost_amount = Decimal("50.00")
    seeded_db.commit()

    assert _remaining(seeded_client, headers, deposit.id) == Decimal("250.00")


def test_remaining_never_negative():
    """退还 + 损失超过实收时剩余按 0 计。

    库里有 CHECK（`ck_deposits_released_amount_within_paid`）保证正常写路径不会出现
    这种行，这里直接构造输出模型，守住「即使历史数据/旁路写入异常也不显示负数」的兜底。
    """
    from datetime import datetime

    from app.finance.schemas import DepositOut

    row = DepositOut(
        id=1,
        pool_id=1,
        paid_amount=Decimal("300.00"),
        returned_amount=Decimal("250.00"),
        lost_amount=Decimal("100.00"),
        status="PAID",
        paid_on=TODAY,
        created_at=datetime(2026, 10, 4, 9, 0),
        operator="pytest",
    )
    assert row.remaining_amount == Decimal("0.00")


def test_deposit_row_keeps_remaining_in_sync_with_orm(seeded_client, seeded_db, headers):
    deposit = _deposit(seeded_db, "800.00")
    deposit.returned_amount = Decimal("300.00")
    deposit.lost_amount = Decimal("100.00")
    seeded_db.commit()

    stored = seeded_db.scalar(select(Deposit).where(Deposit.id == deposit.id))
    assert stored is not None
    assert (
        Decimal(stored.paid_amount) - Decimal(stored.returned_amount) - Decimal(stored.lost_amount)
        == Decimal("400.00")
    )
    assert _remaining(seeded_client, headers, deposit.id) == Decimal("400.00")
