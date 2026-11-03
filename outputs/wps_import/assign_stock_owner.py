"""把回收人回填到库存账号（stocks.note）。

两级来源，账号表优先：
1. **账号表**（WPS「回收账号登记」49 条）：按 game_account 精确匹配 → 取「回收人员」昵称，
   经用户 2026-11-01 裁决的映射转成 ERP 真名。这是第一手记录，最准。
2. **订单表兜底**：账号表匹配不上的（占位号），取该库存对应 HS/TH 单的「回收员」。

写法：note 追加「；回收人：X」，不覆盖原有说明。默认 dry-run。
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
DATA = Path("/Users/aries/黑金时代/outputs/wps_import")
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(DATA))

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.settings import get_settings  # noqa: E402
from wps_people import META, ROWS  # noqa: E402

DT = Decimal
TOL = DT("0.02")

# WPS 昵称 -> ERP 真名（用户 2026-11-01 裁决）
NICK_TO_NAME = {
    "企业用户_1210076649": "三三",
    "蒋丞选手": "小轩",
    "何邑": "何一",
    "A-呆呆猫": "凯文",
    "生活也会如你所期": "吉祥",
    "(未填)": None,
    "(空行)": None,
}


def account_sheet_map() -> dict[str, str]:
    """账号 -> 回收人真名（账号表口径）。"""
    out: dict[str, str] = {}
    for _date, acct, _buy, _sell, _sold, code in ROWS:
        if not acct:
            continue
        name = NICK_TO_NAME.get(META[code][0])
        if name and acct.strip() not in out:
            out[acct.strip()] = name
    return out


def order_map(db: Session) -> dict[int, tuple[str, str]]:
    """stock_id -> (回收人, 订单号)，订单表口径。"""
    erp = []
    for row in db.execute(
        text(
            """
            select o.order_no, o.trade_date, o.account_id,
                   coalesce(sum(case when e.event_type = 'BUY' then e.amount else 0 end), 0) as buy_amt,
                   coalesce(sum(case when e.event_type = 'SELL' then e.amount else 0 end), 0) as sell_amt
            from orders o
            left join order_events e on e.order_id = o.id and e.is_posted = true
            where o.order_type in ('HS', 'TH') and o.account_id is not null
            group by o.id, o.order_no, o.trade_date, o.account_id
            order by o.id
            """
        )
    ):
        m = row._mapping
        erp.append(
            {
                "order_no": m["order_no"],
                "date": m["trade_date"].isoformat(),
                "stock_id": m["account_id"],
                "buy": DT(str(m["buy_amt"])).quantize(TOL),
                "sell": DT(str(m["sell_amt"])).quantize(TOL),
            }
        )

    wps = json.loads((DATA / "wps_orders.json").read_text())
    pool = defaultdict(list)
    for w in wps:
        key = (
            w["date"],
            DT(str(w["principal"])).quantize(TOL),
            (DT(str(w["principal"])) + DT(str(w["profit"]))).quantize(TOL),
        )
        pool[key].append(w)

    out: dict[int, tuple[str, str]] = {}
    for o in erp:
        key = (o["date"], o["buy"], o["sell"])
        w = None
        if pool[key]:
            w = pool[key].pop(0)
        elif o["sell"] == o["buy"]:
            for k, bucket in pool.items():
                if k[0] == o["date"] and k[1] == o["buy"] and bucket:
                    w = bucket.pop(0)
                    break
        if w is None:
            continue
        people = w["recover_by"] or []
        if people:
            out[o["stock_id"]] = (people[0], o["order_no"])
    return out


def main(apply: bool) -> None:
    db = Session(create_engine(get_settings().alembic_url))
    by_account = account_sheet_map()
    by_order = order_map(db)

    stocks = [
        {"id": r[0], "stock_no": r[1], "game_account": r[2], "note": r[3]}
        for r in db.execute(text("select id, stock_no, game_account, note from stocks order by id"))
    ]

    plan, conflicts, from_sheet, from_order, unknown = [], [], 0, 0, []
    for s in stocks:
        acct = (s["game_account"] or "").strip()
        sheet_name = by_account.get(acct)
        order_name, order_no = by_order.get(s["id"], (None, None))
        if sheet_name and order_name and sheet_name != order_name:
            conflicts.append((s["stock_no"], acct, sheet_name, order_name, order_no))
            continue  # 口径冲突不猜，留空待人工裁决
        who = sheet_name or order_name
        if who is None:
            unknown.append((s["stock_no"], acct))
            continue
        if sheet_name:
            from_sheet += 1
        else:
            from_order += 1
        plan.append({"id": s["id"], "stock_no": s["stock_no"], "who": who, "note": s["note"]})

    print(f"库存 {len(stocks)} 个 → 可回填 {len(plan)} 个")
    print(f"  账号表口径 {from_sheet} 个 | 订单表兜底 {from_order} 个 | 无法确定 {len(unknown)} 个")
    if unknown:
        for sno, acct in unknown:
            print(f"    未定: {sno} {acct}")
    if conflicts:
        print(f"\n!! 两表口径冲突 {len(conflicts)} 处（已跳过，留空待裁决）：")
        for c in conflicts:
            print(f"   {c[0]} 账号{c[1]} 账号表={c[2]} 订单表={c[3]}({c[4]})")
    print("\n回收人分布:")
    for k, v in Counter(p["who"] for p in plan).most_common():
        print(f"  {k:6s} {v} 个")

    if apply:
        ok = 0
        for p in plan:
            base = p["note"] or ""
            if "回收人：" in base:
                continue
            new = f"{base}；回收人：{p['who']}" if base else f"回收人：{p['who']}"
            db.execute(text("update stocks set note = :n where id = :i"), {"n": new, "i": p["id"]})
            ok += 1
        db.commit()
        print(f"\n已更新 {ok} 个库存账号的 note")
    else:
        print("\n（dry-run 未写库）")

    db.close()


if __name__ == "__main__":
    main("--apply" in sys.argv)
