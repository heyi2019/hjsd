"""把 WPS 订单表的人员标注（回收员/售卖员）落到 ERP 的 order_profit_allocations。

流程：
1. 从 PG 读 103 单的金额画像（BUY/SELL 事件聚合）
2. 与 wps_orders.json 按 (日期, 本金, 成交额) 配对
3. 按「参与人」生成分润计划

默认 dry-run。--apply 写库（走 policy.allocations.set_allocations 的「按人」口径）。

口径（待用户确认，先按最中性方案实现）：
- 单人包干单  → 一行 OWNER 100%
- 多人单      → 按人头均分，每人一行 OWNER
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

# WPS 昵称 -> ERP 显示名（用户 2026-11-01 裁决）
NICK_TO_NAME = {
    "蒋丞选手": "小轩",
    "何邑": "何一",
    "A-呆呆猫": "凯文",
    "生活也会如你所期": "吉祥",
    "企业用户_1210076649": "三三",
}

# WPS 订单表里的回收员/售卖员本来就是业务人名，不需要转换
IDENTITY = {"小轩", "三三", "小周", "凯文", "何一", "吉祥"}


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

    # 用户表：显示名 / 用户名 都能查到 id（三三的 display_name 是「李三」）
    users: dict[str, int] = {}
    for u in db.scalars(select(User)).all():
        users[u.display_name] = u.id
        users.setdefault(u.username, u.id)
    print(f"系统用户: { {k: v for k, v in users.items()} }")
    missing = [n for n in IDENTITY if n not in users]
    if missing:
        print(f"!! 缺少用户: {missing}")

    # 配对：ERP 的 SELL 事件金额 = 本金 + 利润（回笼 + 收益），
    # 而 WPS 的「交易金额」是成交总额 gross，两者不等价，必须用 principal+profit。
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
            # 零利润单（WPS 记负利润、ERP 按 0 落账）：退化为只按本金+日期匹配
            for k, bucket in pool.items():
                if k[0] == o["date"] and k[1] == o["buy"] and bucket:
                    w = bucket.pop(0)
                    break
        if w is not None:
            matched.append({**o, "wps": w})
        else:
            unmatched.append(o)

    print(f"\n配对成功 {len(matched)} / {len(erp)}")
    if unmatched:
        print(f"未配对 ERP 单 {len(unmatched)} 条：")
        for o in unmatched[:30]:
            print(f"  {o['date']} {o['order_no']:10s} {o['order_type']:3s} buy={o['buy']:>10} sell={o['sell']:>10}")

    # 生成分润计划
    plan = []
    single = multi = 0
    by_person = defaultdict(lambda: DT("0"))
    bad = []
    for o in matched:
        w = o["wps"]
        people = sorted(set(w["recover_by"]) | set(w["sell_by"]))
        if not people:
            bad.append(o["order_no"])
            continue
        ids = []
        for p in people:
            uid = users.get(p)
            if uid is None:
                bad.append(f"{o['order_no']}:{p}")
            else:
                ids.append((p, uid))
        if len(ids) != len(people):
            continue
        if len(people) == 1:
            single += 1
            rate = DT("100")
        else:
            multi += 1
            rate = (DT("100") / len(people)).quantize(DT("0.01"))
        items = [
            {"user_id": uid, "role": "OWNER", "allocation_rate": str(rate), "allocation_amount": "0"}
            for p, uid in ids
        ]
        # 均分除不尽时补差给第一个人
        diff = DT("100") - rate * len(people)
        if diff != 0:
            items[0]["allocation_rate"] = str(rate + diff)
        plan.append({"order": o, "who": people, "items": items})
        profit = o["sell"] - o["buy"]
        for p in people:
            by_person[p] += profit / len(people)

    print(f"\n分润计划 {len(plan)} 单：单人 {single} / 多人 {multi}")
    if bad:
        print(f"!! 异常 {len(bad)}: {bad[:10]}")

    print("\n=== 按人汇总（均分口径，仅参考）===")
    for p, amt in sorted(by_person.items(), key=lambda x: -x[1]):
        print(f"  {p:6s} 利润 {amt:>12,.2f}")

    if apply:
        from app.policy.allocations import set_allocations

        ok = fail = 0
        errs = []
        for entry in plan:
            o = entry["order"]
            try:
                with db.begin_nested():
                    set_allocations(
                        db,
                        o["id"],
                        items=entry["items"],
                        actor="wps-import",
                    )
                ok += 1
            except Exception as exc:  # noqa: BLE001
                fail += 1
                errs.append(f"{o['order_no']}: {str(exc)[:120]}")
        db.commit()
        print(f"\n写库：成功 {ok} / 失败 {fail}")
        for e in errs[:10]:
            print("  ", e)
    else:
        print("\n（dry-run 未写库）")
        print("\n=== 前 5 单示例 ===")
        for entry in plan[:5]:
            o = entry["order"]
            print(f"  {o['order_no']:10s} {o['date']} {o['order_type']:3s} "
                  f"利润{o['sell'] - o['buy']:>9} -> {entry['who']} {[i['allocation_rate'] for i in entry['items']]}")

    db.close()


if __name__ == "__main__":
    main("--apply" in sys.argv)
