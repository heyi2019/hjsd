"""逐笔确认总表 v3：以 WPS订单_规范化.csv（141 行，完整源）为基准，
逐笔对 ERP 118 单，一行一结论。

基准表列：序号 / 日期 / WPS类型 / ERP类型 / 交易金额 / 本金 / 利润 / 导入动作
匹配键：日期 + ERP类型 + 本金 + 利润（四元组唯一）

输出：
  audit_all.csv   —— 141 行逐笔（含被跳过的 30 行）
  终端摘要
"""
from __future__ import annotations

import csv
import sys
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")
sys.path.insert(0, str(Path(__file__).parent))

from audit_orders import fetch_orders  # noqa: E402

BASE = Path(__file__).parent
SRC = BASE / "WPS订单_规范化.csv"
OUT = BASE / "audit_all.csv"


def d(v) -> D:
    return D(str(v or 0)).quantize(D("0.01"))


def main() -> None:
    src = list(csv.DictReader(SRC.open(encoding="utf-8-sig")))
    orders = fetch_orders()

    # ERP 侧索引：日期+类型 分组，供匹配
    pool = list(orders.values())
    for o in pool:
        o["_buy"] = o["buy"]["amount"] if o["buy"] else D("0")
        o["_sell"] = o["sell"]["amount"] if o["sell"] else None
        o["_used"] = False

    # 全部流水（用于识别「未建单但直接记流水」的行）
    from app.core.database import get_session_factory
    from sqlalchemy import text as _text
    _s = get_session_factory()()
    flows_all = [
        {"no": r[0], "day": r[1], "direction": r[2], "amount": D(str(r[3])), "order_id": r[4]}
        for r in _s.execute(_text(
            "select flow_no, occurred_on, direction, amount, order_id from cashflow"
        )).all()
    ]
    _s.close()

    out_rows, miss, extra = [], [], []
    stat = {"精确": 0, "日期差": 0, "金额差": 0, "未匹配": 0, "按规则跳过": 0, "记流水": 0}

    for r in src:
        seq = r["序号"]
        day = r["日期"]
        day_d = __import__("datetime").date.fromisoformat(day)
        code = r["ERP业务类型"]
        amount = d(r["交易金额"])
        principal = d(r["本金"])
        profit = d(r["利润"])
        action = r["导入动作"]

        if code == "—":
            stat["按规则跳过"] += 1
            # 跳过行是否已落地（返点/打赏应各自有收入流水）
            hits = [f for f in flows_all if f["amount"] == profit and f["day"] == day_d
                    and f["order_id"] is None and f["direction"] == "IN"]
            if hits:
                ok = f"已入账 {hits[0]['no']} IN {hits[0]['amount']}"
            else:
                ok = "未入账"
            out_rows.append([seq, day, r["WPS订单类型"], "—", amount, principal, profit,
                             "", "", "", "", action, f"跳过（{action}）· {ok}"])
            continue

        # 本金为 0 的行（提号/违约金未填本金）：允许用「成交-利润」倒推的补录本金
        implied = (amount - profit) if principal == 0 else principal
        cand = [o for o in pool if not o["_used"] and o["type"] == code
                and o["_buy"] in (principal, implied)]
        hit, lvl = None, ""
        for o in cand:
            expect = profit if code == "DG" else principal + profit
            if o["_sell"] == expect and o["day"] == day_d:
                hit, lvl = o, "精确"
                break
        if not hit:
            for o in cand:
                expect = profit if code == "DG" else principal + profit
                if o["_sell"] == expect:
                    hit, lvl = o, f"日期差(表{day} 库{o['day']})"
                    break
        if not hit and cand:
            hit, lvl = cand[0], "金额差"
        if not hit:
            # 无本金行可能未建单、直接记为一笔流水（如违约金）——查流水核对
            flow = None
            for f in flows_all:
                if f["amount"] == profit and f["day"] == day_d and f["order_id"] is None:
                    flow = f
                    break
            if flow:
                stat["记流水"] += 1
                out_rows.append([seq, day, r["WPS订单类型"], code, amount, principal, profit,
                                 "", "", "", "", action,
                                 f"未建单·已直接记流水 {flow['no']} {flow['direction']} {flow['amount']}"])
            else:
                stat["未匹配"] += 1
                miss.append((seq, day, code, amount, principal, profit))
                out_rows.append([seq, day, r["WPS订单类型"], code, amount, principal, profit,
                                 "", "", "", "", action, "未匹配"])
            continue

        hit["_used"] = True
        stat["精确" if lvl == "精确" else ("日期差" if lvl.startswith("日期") else "金额差")] += 1
        note = []
        if lvl != "精确":
            note.append(lvl)
        # 原表自洽：成交额 - 本金 应等于利润
        if code != "DG" and (amount - principal) != profit:
            note.append(f"原表成交-本金={amount - principal}≠利润{profit}")
        out_rows.append([
            seq, day, r["WPS订单类型"], code, amount, principal, profit,
            hit["no"], hit["buy"]["amount"] if hit["buy"] else "",
            hit["sell"]["amount"] if hit["sell"] else "",
            hit["day"], action, "; ".join(note) or "OK",
        ])

    for o in pool:
        if not o["_used"]:
            extra.append(o)

    with OUT.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["WPS序号", "WPS日期", "WPS类型", "ERP类型", "原表成交额", "原表本金", "原表利润",
                    "ERP单号", "ERP_BUY", "ERP_SELL", "ERP日期", "导入动作", "结论"])
        w.writerows(out_rows)

    n_order = sum(1 for r in src if r["ERP业务类型"] != "—")
    print(f"源 {len(src)} 行 = 建单 {n_order} + 跳过 {stat['按规则跳过']}")
    print(f"匹配：精确 {stat['精确']} / 日期差 {stat['日期差']} / 金额差 {stat['金额差']} / "
          f"记流水 {stat['记流水']} / 未匹配 {stat['未匹配']}")
    print(f"ERP 未被覆盖 {len(extra)} 单：")
    for o in extra:
        print(f"  {o['no']} {o['type']} {o['day']} BUY={o['_buy']} SELL={o['_sell']} | {(o['note'] or '')[:40]}")

    print("\n跳过行金额：成交", sum(d(r["交易金额"]) for r in src if r["ERP业务类型"] == "—"),
          "利润", sum(d(r["利润"]) for r in src if r["ERP业务类型"] == "—"))
    print(f"\n明细 → {OUT}")


if __name__ == "__main__":
    main()
