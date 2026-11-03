"""资金口径差 68,143.98 的对账桥（只读）。

WPS 流水表净 45,331.53 vs ERP 系统余额 113,475.51，差 68,143.98。
拆法：

    WPS 196 行 = 账号回收 106 行 + 非订单 90 行（投资款/费用/薪资等）
    ERP 400 笔 = 订单侧流水（由 199 个订单事件派生）+ 非订单流水

    非订单 90 行两边金额完全一致（74,399.70），
    差额落在两处：
        ① ERP 订单侧净 37,092.43  vs  WPS 账号回收净 −29,068.17   → 66,160.60
        ② 订单表派生、WPS 流水表里没有的附加收入（返点29笔 + 打赏188 + 违约金51.50） → 1,983.38
        合计 68,143.98
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402

RAW = Path("/Users/aries/黑金时代/rawdata/原始数据/sheet3_cashflow.json")
OUT = Path(__file__).with_name("reconcile_bridge.csv")


def parse_day(v):
    v = (v or "").strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


def wps_rows():
    recs = json.loads(RAW.read_text(encoding="utf-8"))["records"]
    out = []
    for r in recs:
        f = r.get("fields") or {}
        if (f.get("类别") or "").strip() != "账号回收":
            continue
        out.append({
            "day": parse_day(f.get("日期")),
            "dir": "IN" if f.get("收支") == "收入" else "OUT",
            "amount": D(str(f.get("金额") or 0)).quantize(D("0.01")),
            "memo": (f.get("明细") or "").strip(),
        })
    return out


def main() -> None:
    wps = wps_rows()
    s = get_session_factory()()
    evs = [{"no": r[0], "kind": "BUY" if r[1] == "BUY" else "SELL", "amount": D(str(r[2])),
            "day": r[3], "order_no": r[4], "order_type": r[5], "used": False}
           for r in s.execute(text("""
               select e.event_no, e.event_type, e.amount, e.occurred_on, o.order_no, o.order_type
               from order_events e join orders o on o.id = e.order_id
               order by e.occurred_on, e.id""")).all()]
    erp_in = D(str(s.execute(text("select coalesce(sum(amount),0) from cashflow where order_id is not null and direction='IN'")).scalar()))
    erp_out = D(str(s.execute(text("select coalesce(sum(amount),0) from cashflow where order_id is not null and direction='OUT'")).scalar()))
    non_in = D(str(s.execute(text("select coalesce(sum(amount),0) from cashflow where order_id is null and direction='IN'")).scalar()))
    non_out = D(str(s.execute(text("select coalesce(sum(amount),0) from cashflow where order_id is null and direction='OUT'")).scalar()))
    total = D(str(s.execute(text("select coalesce(sum(case when direction='IN' then amount else -amount end),0) from cashflow")).scalar()))
    s.close()

    def take(pred):
        for e in evs:
            if not e["used"] and pred(e):
                e["used"] = True
                return e
        return None

    rows = []
    for w in wps:
        kind = "BUY" if w["dir"] == "OUT" else "SELL"
        e = take(lambda x, k=kind, w=w: x["kind"] == k and x["amount"] == w["amount"] and x["day"] == w["day"])
        lvl = "金额+日"
        if e is None:
            e = take(lambda x, k=kind, w=w: x["kind"] == k and x["amount"] == w["amount"])
            lvl = "仅金额" if e else ""
        rows.append((w, e, lvl))

    matched = [r for r in rows if r[1]]
    only_wps = [r for r in rows if not r[1]]
    only_erp = [e for e in evs if not e["used"]]

    wps_in = sum(w["amount"] for w in wps if w["dir"] == "IN")
    wps_out = sum(w["amount"] for w in wps if w["dir"] == "OUT")
    ow_in = sum(r[0]["amount"] for r in only_wps if r[0]["dir"] == "IN")
    ow_out = sum(r[0]["amount"] for r in only_wps if r[0]["dir"] == "OUT")
    oe_buy = sum(e["amount"] for e in only_erp if e["kind"] == "BUY")
    oe_sell = sum(e["amount"] for e in only_erp if e["kind"] == "SELL")

    print(f"WPS 账号回收 {len(wps)} 行：IN {wps_in:,} / OUT {wps_out:,} / 净 {wps_in - wps_out:,}")
    print(f"ERP 订单侧流水 {len(evs)} 事件：IN {erp_in:,} / OUT {erp_out:,} / 净 {erp_in - erp_out:,}")
    print(f"ERP 非订单流水：IN {non_in:,} / OUT {non_out:,} / 净 {non_in - non_out:,}")
    print(f"ERP 系统总额：{total:,}")
    print(f"\n匹配 {len(matched)}/{len(wps)} 行"
          f"（金额+日 {sum(1 for r in matched if r[2] == '金额+日')}，仅金额 {sum(1 for r in matched if r[2] == '仅金额')}）")
    print(f"仅 WPS 有（实际走账、系统无对应事件）：{len(only_wps)} 行  IN {ow_in:,} / OUT {ow_out:,}")
    print(f"仅 ERP 有（业务已记、WPS 无走账）：{len(only_erp)} 条  BUY {oe_buy:,} / SELL {oe_sell:,}")

    net_wps = ow_in - ow_out
    net_erp = oe_sell - oe_buy
    # WPS 非订单侧净额 = WPS 全表净额 − 账号回收净额
    recs = json.loads(RAW.read_text(encoding="utf-8"))["records"]
    wps_total = D(0)
    for r in recs:
        f = r.get("fields") or {}
        amt = D(str(f.get("金额") or 0)).quantize(D("0.01"))
        wps_total += amt if f.get("收支") == "收入" else -amt
    wps_recovery = wps_in - wps_out
    wps_non = wps_total - wps_recovery
    print(f"\nWPS 全表净 {wps_total:,} = 账号回收 {wps_recovery:,} + 非订单 {wps_non:,}")
    print(f"① 订单侧差：ERP 净 {erp_in - erp_out:,} − WPS 账号回收净 {wps_recovery:,} = "
          f"{(erp_in - erp_out) - wps_recovery:,}")
    print(f"② 非订单侧差：ERP 净 {non_in - non_out:,} − WPS 净 {wps_non:,} = "
          f"{(non_in - non_out) - wps_non:,}"
          f"（返点 1,743.88 + 打赏 188.00 + 违约金 51.50）")
    bridge = ((erp_in - erp_out) - wps_recovery) + ((non_in - non_out) - wps_non)
    print(f"合计：{bridge:,}  目标 68,143.98 → {'一致' if bridge == D('68143.98') else '不一致'}")
    print(f"\n交叉校验：仅WPS净 {net_wps:,} − 仅ERP净 {net_erp:,} = {net_wps - net_erp:,}")

    with OUT.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["来源", "日期", "方向/类型", "金额", "匹配级别", "ERP单号", "ERP事件号", "备注"])
        for wp, e, lvl in rows:
            w.writerow(["WPS", wp["day"], wp["dir"], wp["amount"], lvl,
                        e["order_no"] if e else "", e["no"] if e else "", wp["memo"]])
        for e in only_erp:
            w.writerow(["ERP", e["day"], e["kind"], e["amount"], "未匹配", e["order_no"], e["no"],
                        f"{e['order_type']} 类业务已记、WPS 无走账"])
    print(f"\n明细已写 {OUT.name}")


if __name__ == "__main__":
    main()
