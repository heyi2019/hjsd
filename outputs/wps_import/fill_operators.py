"""把 WPS 订单表的回收员/售卖员补成订单事件的「操作人」。

按操作分润（买号/售出/运营/公司四项）要求 BUY、SELL 事件能绑定执行人。
导入时事件 created_by 统一写成了 wps-import，对应不到系统用户，
因此把真实业务人员写进 order_events.operator_user_ids：

- BUY  事件 → 该单的回收员
- SELL 事件 → 该单的售卖员

配对键与 allocate.py 一致：(日期, 本金, 本金+利润)。

默认 dry-run，--apply 才写库。
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

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.settings import get_settings  # noqa: E402
from app.domain.users import User  # noqa: E402

DT = Decimal
TOL = DT("0.02")


def load_erp_orders(db: Session) -> list[dict]:
    sql = text(
        """
        select o.id, o.order_no, o.order_type, o.trade_date,
               coalesce(sum(case when e.event_type = 'BUY' then e.amount else 0 end), 0) as buy_amt,
               coalesce(sum(case when e.event_type = 'SELL' then e.amount else 0 end), 0) as sell_amt
        from orders o
        left join order_events e on e.order_id = o.id and e.is_posted = true
        group by o.id, o.order_no, o.order_type, o.trade_date
        order by o.trade_date, o.order_no
        """
    )
    out = []
    for row in db.execute(sql):
        m = row._mapping
        out.append(
            {
                "id": m["id"],
                "order_no": m["order_no"],
                "order_type": m["order_type"],
                "date": m["trade_date"].isoformat(),
                "buy": DT(str(m["buy_amt"])).quantize(TOL),
                "sell": DT(str(m["sell_amt"])).quantize(TOL),
            }
        )
    return out


def main(apply: bool) -> None:
    settings = get_settings()
    engine = create_engine(settings.alembic_url)
    db = Session(engine)

    erp = load_erp_orders(db)
    wps = json.loads((DATA / "wps_orders.json").read_text())
    print(f"ERP 订单 {len(erp)} 单 | WPS 订单 {len(wps)} 行")

    users: dict[str, int] = {}
    for u in db.scalars(select(User)).all():
        users[u.display_name] = u.id
        users.setdefault(u.username, u.id)

    pool = defaultdict(list)
    for w in wps:
        key = (
            w["date"],
            DT(str(w["principal"])).quantize(TOL),
            (DT(str(w["principal"])) + DT(str(w["profit"]))).quantize(TOL),
        )
        pool[key].append(w)

    matched, unmatched = [], []
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
        (matched if w is not None else unmatched).append({**o, "wps": w} if w else o)

    print(f"配对成功 {len(matched)} / {len(erp)}")
    if unmatched:
        print(f"未配对 {len(unmatched)} 单（保持操作人为空）")

    plan: list[dict] = []
    unknown: Counter[str] = Counter()
    no_buy_event: list[str] = []
    for o in matched:
        w = o["wps"]
        buy_ids, sell_ids = [], []
        for name in w["recover_by"]:
            uid = users.get(name)
            if uid is None:
                unknown[name] += 1
            else:
                buy_ids.append(uid)
        for name in w["sell_by"]:
            uid = users.get(name)
            if uid is None:
                unknown[name] += 1
            else:
                sell_ids.append(uid)
        plan.append({**o, "buy_ids": buy_ids, "sell_ids": sell_ids,
                     "recover_by": w["recover_by"], "sell_by": w["sell_by"]})

    # 事件存在性核对
    for p in plan:
        evs = db.execute(
            text("select event_type, count(*) from order_events where order_id = :oid group by 1"),
            {"oid": p["id"]},
        ).fetchall()
        types = {r[0]: r[1] for r in evs}
        p["has_buy"] = types.get("BUY", 0)
        p["has_sell"] = types.get("SELL", 0)
        if not types.get("BUY"):
            no_buy_event.append(p["order_no"])

    dup_buy = sum(1 for p in plan if len(p["buy_ids"]) > 1)
    dup_sell = sum(1 for p in plan if len(p["sell_ids"]) > 1)
    empty_buy = sum(1 for p in plan if not p["buy_ids"])
    empty_sell = sum(1 for p in plan if not p["sell_ids"])

    print(f"\n=== 计划 ===")
    print(f"  BUY  多人回收：{dup_buy} 单 | 无回收员：{empty_buy} 单")
    print(f"  SELL 多人售卖：{dup_sell} 单 | 无售卖员：{empty_sell} 单")
    print(f"  无 BUY 事件（代挂等）：{len(no_buy_event)} 单")
    if unknown:
        print(f"!! 未匹配到系统用户的人名：{dict(unknown)}")

    print("\n=== 前 8 单示例 ===")
    for p in plan[:8]:
        print(f"  {p['order_no']:10s} {p['order_type']:3s} BUY={p['recover_by']}->{[users.get(x, '?') for x in p['recover_by']]} "
              f"SELL={p['sell_by']}->{[users.get(x, '?') for x in p['sell_by']]}")

    if not apply:
        print("\n（dry-run 未写库）")
        db.close()
        return

    ok = fail = 0
    errs: list[str] = []
    for p in plan:
        for etype, ids in (("BUY", p["buy_ids"]), ("SELL", p["sell_ids"])):
            if not ids:
                continue
            try:
                with db.begin_nested():
                    n = db.execute(
                        text(
                            "update order_events set operator_user_ids = cast(:ids as json) "
                            "where order_id = :oid and event_type = :et"
                        ),
                        {"ids": json.dumps(ids), "oid": p["id"], "et": etype},
                    ).rowcount
                if n:
                    ok += n
            except Exception as exc:  # noqa: BLE001
                fail += 1
                errs.append(f"{p['order_no']}:{etype}: {str(exc)[:100]}")
    db.commit()
    print(f"\n写库：更新 {ok} 行事件，失败 {fail}")
    for e in errs[:10]:
        print("  ", e)
    db.close()


if __name__ == "__main__":
    main("--apply" in sys.argv)
