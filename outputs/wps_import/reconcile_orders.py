"""把 WPS「账号回收」151 条与 ERP 订单事件（BUY/SELL/COST）逐笔对账。

匹配口径：
  支出 ↔ BUY / COST，收入 ↔ SELL；金额精确相等，日期允许 ±7 天。
  贪心：先按日期差最小配对，再对余量做「同订单多条事件求和 ↔ 单条 WPS」聚合匹配。

只读，不写库。
"""
from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date
from decimal import Decimal
from pathlib import Path

from sqlalchemy import text

import sys

sys.path.insert(0, "/Users/aries/黑金时代/backend")
from app.core.database import get_session_factory  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

LEDGER = Path("/Users/aries/黑金时代/outputs/wps_import/wps_ledger_20261102.csv")
TOL_DAYS = 7


def load_wps() -> list[dict]:
    rows = [
        r
        for r in csv.DictReader(LEDGER.open(encoding="utf-8-sig"))
        if r["类别"] == "账号回收"
    ]
    out = []
    for i, r in enumerate(rows):
        out.append(
            {
                "key": f"W{i}",
                "day": date.fromisoformat(r["日期"]),
                "dir": r["收支"],
                "amount": Decimal(r["金额"]),
                "detail": r["明细"],
            }
        )
    return out


def load_erp(session) -> list[dict]:
    rows = session.execute(
        text(
            """
            select o.order_no, o.order_type, ev.event_type, ev.amount, ev.occurred_on,
                   ev.portion, ev.event_no
            from order_events ev join orders o on o.id = ev.order_id
            order by ev.occurred_on, ev.id
            """
        )
    ).all()
    return [
        {
            "key": event_no,
            "order_no": order_no,
            "order_type": order_type,
            "event_type": event_type,
            "day": occurred_on,
            "amount": Decimal(str(amount)),
            "portion": portion,
            "dir": "支出" if event_type in ("BUY", "COST") else "收入",
        }
        for order_no, order_type, event_type, amount, occurred_on, portion, event_no in rows
    ]


def greedy(wps: list[dict], erp: list[dict]) -> None:
    """金额精确 + 方向一致 + 日期差最小，一对一贪心配对。"""
    pairs = []
    for w in wps:
        for e in erp:
            if w["dir"] != e["dir"] or w["amount"] != e["amount"]:
                continue
            delta = abs((w["day"] - e["day"]).days)
            if delta <= TOL_DAYS:
                pairs.append((delta, w, e))
    pairs.sort(key=lambda x: (x[0], x[1]["day"], x[1]["key"], x[2]["key"]))
    used_w, used_e = set(), set()
    for _, w, e in pairs:
        if w["key"] in used_w or e["key"] in used_e:
            continue
        used_w.add(w["key"])
        used_e.add(e["key"])
        w["match"] = e["key"]
        e["match"] = w["key"]


def aggregate(wps: list[dict], erp: list[dict]) -> list[tuple]:
    """把同一订单的多条事件求和，去匹配单条 WPS 记录。"""
    left_w = [w for w in wps if "match" not in w]
    left_e = [e for e in erp if "match" not in e]
    by_order: dict[str, list[dict]] = defaultdict(list)
    for e in left_e:
        by_order[e["order_no"]].append(e)
    hits = []
    for order_no, events in by_order.items():
        if len(events) < 2:
            continue
        total = sum(e["amount"] for e in events)
        dirs = {e["dir"] for e in events}
        if len(dirs) != 1:
            continue
        for w in left_w:
            if "match" in w or w["dir"] not in dirs or w["amount"] != total:
                continue
            if min(abs((w["day"] - e["day"]).days) for e in events) > TOL_DAYS:
                continue
            w["match"] = f"{order_no}({len(events)}条合计)"
            for e in events:
                e["match"] = w["key"]
            hits.append((order_no, total, w["key"], len(events)))
            break
    return hits


def main() -> None:
    wps = load_wps()
    session = get_session_factory(get_settings().alembic_url)()
    erp = load_erp(session)

    greedy(wps, erp)
    agg = aggregate(wps, erp)

    print(f"WPS 账号回收 {len(wps)} 条 / ERP 订单事件 {len(erp)} 条")
    print(
        f"一对一匹配 {sum(1 for w in wps if 'match' in w and '(' not in str(w['match']))}"
        f" / 聚合匹配 {len(agg)} 组"
    )

    left_w = [w for w in wps if "match" not in w]
    left_e = [e for e in erp if "match" not in e]

    print()
    print(f"=== WPS 有、ERP 无（{len(left_w)} 条）===")
    net = Decimal(0)
    for w in sorted(left_w, key=lambda x: x["day"]):
        signed = w["amount"] if w["dir"] == "收入" else -w["amount"]
        net += signed
        print(f"  {w['day']} {w['dir']} {w['amount']:>10,.2f}  {w['detail']}")
    print(f"  净影响 {net:,.2f}")

    print()
    print(f"=== ERP 有、WPS 无（{len(left_e)} 条）===")
    net2 = Decimal(0)
    for e in sorted(left_e, key=lambda x: x["day"]):
        signed = e["amount"] if e["dir"] == "收入" else -e["amount"]
        net2 += signed
        print(
            f"  {e['day']} {e['dir']} {e['amount']:>10,.2f}  {e['order_no']} {e['event_type']}/{e['portion']}"
        )
    print(f"  净影响 {net2:,.2f}")


if __name__ == "__main__":
    main()
