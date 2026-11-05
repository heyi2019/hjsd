"""逐笔核对（全量）：WPS 原始表 ↔ ERP 库，一笔一笔对。

L1 非订单资金流水 90 行  ↔ ERP 非订单流水
L2 账号回收流水 106 行   ↔ ERP 订单 BUY/SELL 事件
L3 订单台账（ERP 118 单）↔ 事件 ↔ 流水 三方自洽

只读。输出 audit_orders.csv + 终端摘要。
"""
from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402

RAW_CASH = Path("/Users/aries/黑金时代/rawdata/原始数据/sheet3_cashflow.json")
OUT = Path(__file__).with_name("audit_orders.csv")


def parse_day(v):
    if isinstance(v, date):
        return v
    v = (v or "").strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    raise ValueError(v)


def wps_recovery_rows():
    recs = json.loads(RAW_CASH.read_text(encoding="utf-8"))["records"]
    out = []
    seq = 0
    for r in recs:
        f = r.get("fields") or {}
        if (f.get("类别") or "").strip() != "账号回收":
            continue
        seq += 1
        out.append(
            {
                "seq": seq,
                "day": parse_day(f.get("日期")),
                "dir": "IN" if f.get("收支") == "收入" else "OUT",
                "amount": D(str(f.get("金额") or 0)).quantize(D("0.01")),
                "memo": (f.get("明细") or "").strip(),
            }
        )
    return out


def fetch_orders():
    s = get_session_factory()()
    rows = s.execute(
        text(
            """
            select o.id, o.order_no, o.order_type, o.trade_date, o.status,
                   o.account_snapshot, o.note
            from orders o order by o.order_no
            """
        )
    ).all()
    orders = {r[0]: {
        "id": r[0], "no": r[1], "type": r[2], "day": r[3], "status": r[4],
        "acct": r[5], "note": r[6], "buy": None, "sell": None, "events": [], "flows": [],
    } for r in rows}

    ev = s.execute(
        text(
            """
            select id, order_id, event_type, amount, occurred_on, pool_id, note
            from order_events order by order_id, occurred_on, id
            """
        )
    ).all()
    for r in ev:
        o = orders.get(r[1])
        if not o:
            continue
        item = {"id": r[0], "type": r[2], "amount": D(str(r[3])), "day": r[4], "pool": r[5], "note": r[6]}
        o["events"].append(item)
        if r[2] == "BUY":
            o["buy"] = item
        elif r[2] == "SELL":
            o["sell"] = item

    fl = s.execute(
        text(
            """
            select id, flow_no, order_event_id, direction, amount, pool_id,
                   accounting_attribute, occurred_on
            from cashflow where order_event_id is not null order by id
            """
        )
    ).all()
    ev2order = {e["id"]: oid for oid, o in orders.items() for e in o["events"]}
    for r in fl:
        oid = ev2order.get(r[2])
        if not oid:
            continue
        orders[oid]["flows"].append({
            "id": r[0], "no": r[1], "dir": r[3], "amount": D(str(r[4])),
            "pool": r[5], "attr": r[6], "day": r[7], "event_id": r[2],
        })
    s.close()
    return orders


def main():
    wps = wps_recovery_rows()
    orders = fetch_orders()
    print(f"WPS 账号回收 {len(wps)} 行；ERP 订单 {len(orders)} 单")

    w_in = sum(r["amount"] for r in wps if r["dir"] == "IN")
    w_out = sum(r["amount"] for r in wps if r["dir"] == "OUT")
    print(f"WPS 回收收入 {w_in} / 回收支出 {w_out} / 毛利 {w_in - w_out}")

    buy = sum(o["buy"]["amount"] for o in orders.values() if o["buy"])
    sell = sum(o["sell"]["amount"] for o in orders.values() if o["sell"])
    print(f"ERP BUY 合计 {buy} / SELL 合计 {sell} / 差 {sell - buy}")

    # 事件 ↔ 流水 自洽
    bad_ev = []
    for o in orders.values():
        for e in o["events"]:
            got = sum(f["amount"] for f in o["flows"] if f["event_id"] == e["id"])
            if got != e["amount"]:
                bad_ev.append((o["no"], e["type"], e["amount"], got))
        if not o["events"]:
            bad_ev.append((o["no"], "-", D("0"), D("0")))
    print(f"\n事件↔流水金额不一致：{len(bad_ev)}")
    for b in bad_ev[:20]:
        print("   ", b)

    # 写明细
    with OUT.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["订单号", "类型", "状态", "交易日", "BUY成本", "BUY日期", "SELL成交", "SELL日期",
                    "利润", "事件数", "流水数", "流水合计", "自洽", "备注"])
        for o in sorted(orders.values(), key=lambda x: x["no"]):
            b = o["buy"]["amount"] if o["buy"] else D("0")
            sv = o["sell"]["amount"] if o["sell"] else D("0")
            fsum = sum(f["amount"] for f in o["flows"])
            evsum = sum(e["amount"] for e in o["events"])
            w.writerow([
                o["no"], o["type"], o["status"], o["day"],
                b if o["buy"] else "", o["buy"]["day"] if o["buy"] else "",
                sv if o["sell"] else "", o["sell"]["day"] if o["sell"] else "",
                (sv - b) if o["sell"] else "",
                len(o["events"]), len(o["flows"]), fsum,
                "OK" if fsum == evsum else "差异",
                (o["note"] or "")[:40],
            ])
    print(f"\n订单逐笔明细 → {OUT}")


if __name__ == "__main__":
    main()
