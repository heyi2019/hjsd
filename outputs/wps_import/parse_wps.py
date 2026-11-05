"""解析 WPS 多维表快照（markdown）-> 结构化 JSON。"""
import json
import re
from pathlib import Path

SRC = Path(
    "/Users/aries/.workbuddy/projects/Users-aries-黑金时代/"
    "63e1b7c1-46ea-4238-b540-ac296e925007/tool-results/"
    "call_00_UASgw8Ed8J7sUFuMK0c87748.txt"
)
raw = json.loads(SRC.read_text())["data"]["content"]
lines = raw.split("\n")


def cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def num(v) -> float:
    if v in ("", None):
        return 0.0
    v = str(v).replace("￥", "").replace(",", "").strip()
    try:
        return float(v)
    except ValueError:
        return 0.0


def names(v) -> list[str]:
    if not v:
        return []
    return [x.strip() for x in re.split(r"[,，]", v) if x.strip()]


ORD_HDR = 258
hdr = cells(lines[ORD_HDR])
rows = []
for ln in lines[ORD_HDR + 2 : 403]:
    if not ln.strip().startswith("|"):
        continue
    c = cells(ln)
    if len(c) < len(hdr):
        continue
    d = dict(zip(hdr, c))
    if not d.get("日期"):
        continue
    rows.append(
        {
            "date": d["日期"].split(" ")[0].replace("/", "-"),
            "amount": num(d.get("交易金额")),
            "principal": num(d.get("本金")),
            "profit": num(d.get("利润")),
            "order_type_raw": d.get("订单类型", ""),
            "recover_by": names(d.get("回收员", "")),
            "sell_by": names(d.get("售卖员", "")),
            "accounts": names(d.get("回款账户（本金/利润）", "")),
            "note": d.get("备注", ""),
            "month_raw": d.get("月份", ""),
        }
    )

print("订单表解析行数:", len(rows))
out = Path(__file__).with_name("wps_orders.json")
out.write_text(json.dumps(rows, ensure_ascii=False, indent=1))

import collections

print("类型分布:", dict(collections.Counter(r["order_type_raw"] for r in rows)))
print(
    "金额合计: 交易",
    round(sum(r["amount"] for r in rows), 2),
    "本金",
    round(sum(r["principal"] for r in rows), 2),
    "利润",
    round(sum(r["profit"] for r in rows), 2),
)
print("仅月份无内容的行:", sum(1 for r in rows if not r["order_type_raw"]))
