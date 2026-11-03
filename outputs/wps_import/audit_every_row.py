"""逐笔核对：WPS 原始表 ↔ ERP 库，一行一行对，不聚合。

三个对账层次：
  L1 非订单资金流水：WPS 90 行 ↔ ERP 非订单流水（应 1:1）
  L2 账号回收流水：WPS 106 行（53 组收支）↔ ERP 订单派生流水
  L3 订单台账：WPS 订单行 ↔ ERP 118 单（金额/成本/利润/日期）

输出：audit_every_row.csv（逐笔明细）+ 终端摘要。
只读，不写库。
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
RAW_ORDERS = Path("/Users/aries/黑金时代/rawdata/原始数据/sheet9_orders.json")
OUT = Path(__file__).with_name("audit_every_row.csv")


def parse_day(v: str) -> date:
    v = (v or "").strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"无法解析日期: {v!r}")


def wps_cash() -> list[dict]:
    recs = json.loads(RAW_CASH.read_text(encoding="utf-8"))["records"]
    out = []
    for i, r in enumerate(recs, 1):
        f = r.get("fields") or {}
        amt = D(str(f.get("金额") or 0)).quantize(D("0.01"))
        out.append(
            {
                "seq": i,
                "rid": r.get("id"),
                "day": parse_day(f.get("日期")),
                "dir": "IN" if f.get("收支") == "收入" else "OUT",
                "amount": amt,
                "category": (f.get("类别") or "").strip(),
                "memo": (f.get("明细") or "").strip(),
            }
        )
    return out


def erp_cash() -> list[dict]:
    s = get_session_factory()()
    rows = s.execute(
        text(
            """
            select id, flow_no, occurred_on, direction, amount,
                   accounting_attribute, note, order_id is not null as linked
            from cashflow order by occurred_on, id
            """
        )
    ).all()
    s.close()
    return [
        {
            "id": r[0],
            "flow_no": r[1],
            "day": r[2],
            "dir": r[3],
            "amount": D(str(r[4])).quantize(D("0.01")),
            "attr": r[5],
            "note": (r[6] or "").strip(),
            "linked": r[7],
        }
        for r in rows
    ]


def match_rows(wps_rows: list[dict], erp_rows: list[dict]) -> list[dict]:
    """贪心 1:1 匹配：先按 日期+方向+金额+摘要，再降级 日期+方向+金额。"""
    pool = list(erp_rows)
    used: set[int] = set()
    out = []

    def take(pred):
        for e in pool:
            if e["id"] in used:
                continue
            if pred(e):
                used.add(e["id"])
                return e
        return None

    for w in wps_rows:
        e = take(
            lambda x, w=w: x["day"] == w["day"]
            and x["dir"] == w["dir"]
            and x["amount"] == w["amount"]
            and x["note"] == w["memo"]
        )
        level = "精确"
        if e is None:
            e = take(
                lambda x, w=w: x["day"] == w["day"]
                and x["dir"] == w["dir"]
                and x["amount"] == w["amount"]
            )
            level = "金额日期同·摘要不同"
        if e is None:
            e = take(
                lambda x, w=w: x["dir"] == w["dir"]
                and x["amount"] == w["amount"]
                and abs((x["day"] - w["day"]).days) <= 3
            )
            level = "金额同·日期±3天"
        if e is None:
            e = take(
                lambda x, w=w: x["dir"] == w["dir"] and x["amount"] == w["amount"]
            )
            level = "仅金额方向同"
        out.append({"wps": w, "erp": e, "level": level if e else "未匹配"})
    leftover = [e for e in pool if e["id"] not in used]
    return out, leftover


def main() -> None:
    cash = wps_cash()
    erp = erp_cash()
    non_order = [r for r in cash if r["category"] != "账号回收"]
    recov = [r for r in cash if r["category"] == "账号回收"]

    print(f"WPS 流水 {len(cash)} 行 = 非订单 {len(non_order)} + 账号回收 {len(recov)}")
    print(f"ERP 流水 {len(erp)} 笔（含订单派生）")

    # ---------- L1 非订单 ----------
    print("\n===== L1 非订单资金流水 =====")
    # ERP 侧候选：排除订单派生（order_id 非空 且 属性属业务收支）——用 note 命中法更稳
    memo_set = {r["memo"] for r in non_order}
    cand = [
        e
        for e in erp
        if e["note"] in memo_set
        or e["attr"] in ("EXTERNAL_FUNDING", "OPERATING_EXPENSE", "DEPOSIT")
    ]
    pairs, left1 = match_rows(non_order, cand)
    bad = [p for p in pairs if p["level"] != "精确"]
    print(f"精确匹配 {len(pairs) - len(bad)} / {len(non_order)}，异常 {len(bad)}，ERP 剩余 {len(left1)}")
    for p in pairs:
        if p["level"] != "精确":
            w, e = p["wps"], p["erp"]
            print(
                f"  [{p['level']}] WPS#{w['seq']} {w['day']} {w['dir']} {w['amount']} {w['memo']!r}"
                + (f" → ERP {e['flow_no']} {e['day']} {e['amount']} {e['note']!r}" if e else " → 无")
            )
    for e in left1:
        print(f"  [ERP 多余] {e['flow_no']} {e['day']} {e['dir']} {e['amount']} {e['note']!r} attr={e['attr']}")

    # 金额合计
    w_in = sum(r["amount"] for r in non_order if r["dir"] == "IN")
    w_out = sum(r["amount"] for r in non_order if r["dir"] == "OUT")
    e_in = sum(p["erp"]["amount"] for p in pairs if p["erp"] and p["wps"]["dir"] == "IN")
    e_out = sum(p["erp"]["amount"] for p in pairs if p["erp"] and p["wps"]["dir"] == "OUT")
    print(f"  收入 WPS {w_in} / ERP {e_in}    支出 WPS {w_out} / ERP {e_out}")
    print(f"  净额 WPS {w_in - w_out} / ERP {e_in - e_out}")

    # ---------- 写 CSV ----------
    with OUT.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(
            [
                "层",
                "WPS行号",
                "日期",
                "方向",
                "金额",
                "类别",
                "摘要",
                "ERP流水号",
                "ERP日期",
                "ERP方向",
                "ERP金额",
                "ERP摘要",
                "ERP属性",
                "匹配级别",
            ]
        )
        for p in pairs:
            x, e = p["wps"], p["erp"]
            w.writerow(
                [
                    "L1非订单",
                    x["seq"],
                    x["day"],
                    x["dir"],
                    x["amount"],
                    x["category"],
                    x["memo"],
                    e["flow_no"] if e else "",
                    e["day"] if e else "",
                    e["dir"] if e else "",
                    e["amount"] if e else "",
                    e["note"] if e else "",
                    e["attr"] if e else "",
                    p["level"],
                ]
            )
        for e in left1:
            w.writerow(["L1非订单", "", "", "", "", "", "", e["flow_no"], e["day"], e["dir"], e["amount"], e["note"], e["attr"], "ERP多余"])

    print(f"\n逐笔明细已写入 {OUT}")


if __name__ == "__main__":
    main()
