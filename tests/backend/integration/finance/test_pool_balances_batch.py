"""POOL-01 资金池批量余额与汇总（FIN-01）。

批量余额与汇总属于财务事实，本文件锁住：

1. 批量接口每池的余额与单池端点完全一致（口径不能分叉）；
2. `totals` 与 items 的 Decimal 累加一致（不是前端那套浮点）；
3. 自有权益只算 `ownership=OWNED` 的池；
4. 无池授权的账号拿到空 items 与零合计，而不是 403 或越权数据。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.domain.enums import PoolOwnership
from app.finance import service as finance_service
from app.foundation import service as foundation_service

TODAY = date(2026, 10, 4)


def _flow(seeded_db, pool_id: int, *, direction: str, amount: str, note: str):
    return finance_service.create_cashflow(
        seeded_db,
        pool_id=pool_id,
        occurred_on=TODAY,
        direction=direction,
        category="OPERATING",
        amount=Decimal(amount),
        note=note,
        actor="pytest",
    )


def test_batch_items_match_single_pool_and_totals_are_decimal_sums(
    seeded_client, seeded_db, headers
):
    _flow(seeded_db, 1, direction="IN", amount="1200.10", note="批量入")
    _flow(seeded_db, 1, direction="OUT", amount="200.05", note="批量出")
    seeded_db.commit()

    batch = seeded_client.get("/api/v1/pools/balances", headers=headers)
    assert batch.status_code == 200, batch.text
    body = batch.json()

    assert body["items"], "至少应返回种子里已有的资金池"
    for item in body["items"]:
        single = seeded_client.get(
            f"/api/v1/pools/{item['pool_id']}/balance", headers=headers
        )
        assert single.status_code == 200, single.text
        assert item["cash_balance"] == single.json()["cash_balance"]
        assert item["available"] == single.json()["available"]
        assert item["deposit_held"] == single.json()["deposit_held"]

    totals = body["totals"]
    assert Decimal(totals["cash_balance"]) == sum(
        (Decimal(item["cash_balance"]) for item in body["items"]), Decimal("0")
    )
    assert Decimal(totals["available"]) == sum(
        (Decimal(item["available"]) for item in body["items"]), Decimal("0")
    )
    assert Decimal(totals["deposit_held"]) == sum(
        (Decimal(item["deposit_held"]) for item in body["items"]), Decimal("0")
    )


def test_owned_cash_excludes_custody_and_third_part_pools(seeded_client, seeded_db, headers):
    custody = foundation_service.create_pool(
        seeded_db,
        code="CUSTODY_PROBE",
        name="代管探针池",
        actor="pytest",
        ownership=PoolOwnership.CUSTODY.value,
    )
    seeded_db.commit()
    _flow(seeded_db, custody.id, direction="IN", amount="999.99", note="代管入账")
    seeded_db.commit()

    body = seeded_client.get("/api/v1/pools/balances", headers=headers).json()
    totals = body["totals"]

    # 代管池计入现金头寸，但不得计入自有权益。
    assert Decimal(totals["cash_balance"]) >= Decimal("999.99")
    owned_by_items = sum(
        (
            Decimal(item["cash_balance"])
            for item in body["items"]
            if item["pool_id"] in {1, 2}
        ),
        Decimal("0"),
    )
    assert Decimal(totals["owned_cash_balance"]) == owned_by_items


def test_account_without_pool_scope_gets_empty_batch(seeded_client, viewer_headers):
    response = seeded_client.get("/api/v1/pools/balances", headers=viewer_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["items"] == []
    assert Decimal(body["totals"]["cash_balance"]) == Decimal("0")
    assert Decimal(body["totals"]["owned_cash_balance"]) == Decimal("0")
