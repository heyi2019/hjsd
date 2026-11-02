"""资金流水列表合计（total_in / total_out）契约（FIN-04）。

背景：合计原先由前端对当页（`limit` 上限 2000）求和，流水超过上限就静默少算，
且用浮点累加金额。现改为服务端按**同一套筛选条件**聚合，本文件锁住四件事：

1. 合计不受 `limit` / `offset` 影响；
2. 合计随筛选参数变化（方向）；
3. 关键字覆盖摘要 / 流水号，且合计跟随关键字；
4. 关键字里的 `%` `_` 被转义，不当通配符用。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

TODAY = date(2026, 10, 4)


def _create(client, headers, *, direction: str, amount: str, note: str) -> dict:
    payload = {
        "pool_id": 1,
        "occurred_on": TODAY.isoformat(),
        "direction": direction,
        "nature": "BUSINESS_IN" if direction == "IN" else "BUSINESS_OUT",
        "category": "OPERATING",
        "amount": amount,
        "note": note,
    }
    response = client.post("/api/v1/cashflows", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def _totals(client, headers, **params):
    """取一次列表响应里的合计；默认 limit=1，用来证明合计不吃分页。"""
    response = client.get(
        "/api/v1/cashflows", params={"limit": 1, **params}, headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return Decimal(str(body["total_in"])), Decimal(str(body["total_out"])), body


def test_totals_cover_all_rows_while_items_respect_limit(seeded_client, headers):
    base_in, base_out, _ = _totals(seeded_client, headers)

    _create(seeded_client, headers, direction="IN", amount="100.00", note="合计-入1")
    _create(seeded_client, headers, direction="IN", amount="250.50", note="合计-入2")
    _create(seeded_client, headers, direction="OUT", amount="30.00", note="合计-出1")

    total_in, total_out, body = _totals(seeded_client, headers)

    # limit=1 只回 1 条明细，合计仍覆盖全部命中行。
    assert len(body["items"]) == 1
    assert body["total"] >= 3
    assert total_in - base_in == Decimal("350.50")
    assert total_out - base_out == Decimal("30.00")


def test_totals_follow_direction_filter(seeded_client, headers):
    _create(seeded_client, headers, direction="IN", amount="88.00", note="方向-入")
    _create(seeded_client, headers, direction="OUT", amount="12.00", note="方向-出")

    total_in, total_out, body = _totals(seeded_client, headers, direction="IN")

    assert body["total"] >= 1
    assert total_out == Decimal("0")
    assert total_in >= Decimal("88.00")


def test_keyword_matches_note_and_flow_no_and_totals_follow(seeded_client, headers):
    marker = f"探针{uuid4().hex[:8]}"
    created = _create(seeded_client, headers, direction="IN", amount="66.60", note=marker)

    total_in, total_out, body = _totals(seeded_client, headers, keyword=marker)
    assert body["total"] == 1
    assert total_in == Decimal("66.60")
    assert total_out == Decimal("0")

    # 流水号也能搜到，大小写不敏感。
    by_flow_no = seeded_client.get(
        "/api/v1/cashflows",
        params={"limit": 10, "keyword": created["flow_no"].lower()},
        headers=headers,
    )
    assert by_flow_no.status_code == 200, by_flow_no.text
    assert by_flow_no.json()["total"] == 1


def test_keyword_wildcards_are_escaped(seeded_client, headers):
    _create(seeded_client, headers, direction="IN", amount="9.99", note="普通摘要")

    # 未转义时 "%" 会匹配全部行，这里必须 0 命中。
    _, _, body = _totals(seeded_client, headers, keyword="%")
    assert body["total"] == 0
    assert Decimal(str(body["total_in"])) == Decimal("0")
