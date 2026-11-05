"""ERP 订单金额 vs WPS 源表（成交/本金/利润）逐单对照，识别 SELL 口径不统一。

ERP note 形如「WPS导入 回收 成交1,000.00 利润250.00」，据此反查 WPS 原始行。
只读。
"""
from __future__ import annotations

import json
import re
import sys
from decimal import Decimal

from sqlalchemy import text

sys.path.insert(0, "/Users/aries/黑金时代/backend")
from app.core.database import get_session_factory  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

SRC = "/Users/aries/黑金时代/outputs/wps_import/wps_orders.json"
NUM = r"([\d,]+\.\d{2}|[\d,]+)"
PAT = re.compile(rf"成交\s*{NUM}.*?利润\s*(-?{NUM})")

TYPE_MAP = {"回收": "回收", "氪金联盟提号": "氪金联盟提号", "代挂": "代挂", "蹭点": "蹭点", "打赏": "打赏"}


def money(s: str) -> Decimal:
    return Decimal(s.replace(",", ""))


def main() -> None:
    rows = json.load(open(SRC))
    s = get_session_factory(get_settings().alembic_url)()
    orders = s.execute(
        text(
            """
            select o.order_no, o.order_type, o.trade_date, o.note,
                   coalesce((select sum(amount) from order_events e
                             where e.order_id=o.id and e.event_type='BUY'), 0) buy,
                   coalesce((select sum(amount) from order_events e
                             where e.order_id=o.id and e.event_type='SELL'), 0) sell
            from orders o order by o.order_no
            """
        )
    ).all()

    used = set()
    print(
        f"{'单号':<9}{'类型':<4}{'ERP_BUY':>11}{'ERP_SELL':>11}"
        f"{'WPS本金':>10}{'WPS利润':>9}{'WPS成交':>10}  口径"
    )
    mode_a = mode_b = mode_c = 0
    odd = []
    for no, otype, day, note, buy, sell in orders:
        note = note or ""
        m = PAT.search(note)
        wps = None
        if m:
            amt, prof = money(m.group(1)), money(m.group(2))
            for i, r in enumerate(rows):
                if i in used:
                    continue
                if Decimal(str(r["amount"])) != amt:
                    continue
                if Decimal(str(r["profit"])) != prof:
                    continue
                wps = (i, r)
                break
        if wps is None:
            print(f"{no:<9}{otype:<4}{buy:>11,.2f}{sell:>11,.2f}{'—':>10}{'—':>9}{'—':>10}  未匹配源行")
            odd.append((no, otype, day, buy, sell, note))
            continue
        i, r = wps
        used.add(i)
        p, f, a = Decimal(str(r["principal"])), Decimal(str(r["profit"])), Decimal(str(r["amount"]))
        if sell == a:
            mode = "SELL=成交额"
            mode_a += 1
        elif sell == p + f:
            mode = "SELL=本金+利润"
            mode_b += 1
        elif sell == buy + f:
            mode = "SELL=BUY+利润"
            mode_c += 1
        else:
            mode = "**不符**"
            odd.append((no, otype, day, buy, sell, f"成交{a} 本金{p} 利润{f}"))
        flag = "" if mode in ("SELL=成交额", "SELL=本金+利润", "SELL=BUY+利润") else "  <<<"
        print(
            f"{no:<9}{otype:<4}{buy:>11,.2f}{sell:>11,.2f}{p:>10,.2f}{f:>9,.2f}{a:>10,.2f}  {mode}{flag}"
        )

    print()
    print(f"SELL=成交额 {mode_a} 单 / SELL=本金+利润 {mode_b} 单 / SELL=BUY+利润 {mode_c} 单")
    print(f"源行未匹配 {len(rows) - len(used)} 行")
    print()
    print("=== 需要人工看的 ===")
    for o in odd:
        print("  ", o)


if __name__ == "__main__":
    main()
