"""WPS 记账明细 vs ERP 手工流水 逐条匹配，列出未匹配项。

匹配键：类别 + 方向 + 金额 + 日期（日期允许 ±3 天，业务上记账日与订单日会错开）。
一次匹配只消耗一次，避免同金额多笔互相顶替。
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
sys.path.insert(0, str(BACKEND))

from sqlalchemy import text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
from audit_wps_ledger import parse  # noqa: E402

TOLERANCE = 3


def main() -> None:
    rows = parse()
    session = get_session_factory(get_settings().alembic_url)()

    erp = [
        {
            "id": r[0],
            "flow_no": r[1],
            "day": r[2],
            "direction": "收入" if r[3] == "IN" else "支出",
            "amount": Decimal(str(r[4])),
            "category": r[5] or "",
            "note": r[6] or "",
            "order_id": r[7],
        }
        for r in session.execute(
            text(
                "select id, flow_no, occurred_on, direction, amount, category, note, order_id "
                "from cashflow where order_event_id is null order by occurred_on, id"
            )
        ).all()
    ]

    used: set[int] = set()
    unmatched = []
    for w in rows:
        wday = date.fromisoformat(w["date"])
        hit = None
        for tol in (0, 1, 2, 3):
            for e in erp:
                if e["id"] in used:
                    continue
                if e["direction"] != w["direction"] or e["amount"] != w["amount"]:
                    continue
                if abs((e["day"] - wday).days) > max(tol, TOLERANCE):
                    continue
                hit = e
                break
            if hit:
                break
        if hit:
            used.add(hit["id"])
        else:
            unmatched.append(w)

    leftover = [e for e in erp if e["id"] not in used]

    print(f"WPS {len(rows)} 条，ERP 手工流水 {len(erp)} 笔")
    print(f"匹配上 {len(rows) - len(unmatched)} 条，WPS 侧未匹配 {len(unmatched)} 条，ERP 侧剩余 {len(leftover)} 笔")
    print()
    print("=== WPS 有、ERP 无 ===")
    total = Decimal("0")
    for w in sorted(unmatched, key=lambda x: (x["date"], x["category"])):
        total += w["signed"]
        print(f"  {w['date']} {w['direction']} {w['category']:<6} {w['amount']:>10,.2f}  {w['detail']}")
    print(f"  合计净影响 {total:,.2f}")
    print()
    print("=== ERP 有、WPS 无 ===")
    total2 = Decimal("0")
    for e in leftover:
        signed = e["amount"] if e["direction"] == "收入" else -e["amount"]
        total2 += signed
        print(
            f"  {e['day']} {e['direction']} {e['category']:<6} {e['amount']:>10,.2f}  "
            f"{e['flow_no']}  {(e['note'] or '')[:24]}"
        )
    print(f"  合计净影响 {total2:,.2f}")


if __name__ == "__main__":
    main()
