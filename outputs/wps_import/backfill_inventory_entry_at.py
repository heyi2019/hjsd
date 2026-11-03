"""把库存「入库时间」（stocks.inventory_entry_at）改为业务日期，口径：取较早者。

问题：WPS 导入时 inventory_entry_at 落的是导入时刻（2026-11-01 19:35），
库存中心「入库时间」列因此全部显示同一天，与真实入库日无关。

口径（2026-11-01 用户裁决「选早的入库」）：
  候选 A：来源订单 trade_date（与 stocks/router.py::_source_orders 同源的取单规则）
  候选 B：回收账号登记表里该账号的登记日期（仅当库存有真实账号号时才存在）
  入库时间 = min(A, B) 当天 00:00:00
  created_at 不动（那是记录创建时刻，不是业务时间）

用法：
    python backfill_inventory_entry_at.py            # dry-run
    python backfill_inventory_entry_at.py --apply    # 写库
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from datetime import date

sys.path.insert(0, "/Users/aries/黑金时代/backend")
sys.path.insert(0, "/Users/aries/黑金时代/outputs/wps_import")

from sqlalchemy import create_engine, text  # noqa: E402

from app.core.settings import get_settings  # noqa: E402
from wps_people import ROWS  # noqa: E402

SOURCE_SQL = """
with src as (
  select s.id stock_id, s.stock_no, s.game_account, s.inventory_entry_at,
         coalesce(
           (select o.id from orders o
             where o.account_id = s.id and o.order_type in ('HS','TH')
               and exists (select 1 from order_events e
                            where e.order_id = o.id and e.event_type = 'BUY' and e.is_posted)
             order by o.trade_date, o.id limit 1),
           (select o.id from orders o
             where o.account_id = s.id and o.order_type in ('HS','TH')
             order by o.trade_date, o.id limit 1),
           (select o.id from orders o
             where o.account_id = s.id and o.order_type = 'DG'
             order by o.trade_date, o.id limit 1)
         ) oid
  from stocks s
)
select src.stock_id, src.stock_no, src.game_account, src.inventory_entry_at,
       o.order_no, o.order_type, o.trade_date
from src left join orders o on o.id = src.oid
order by src.stock_no
"""


def sheet_dates() -> dict[str, date]:
    """账号 -> 回收账号登记表里的登记日期（同账号多次登记取最早）。"""
    out: dict[str, date] = {}
    for row in ROWS:
        d, acct = row[0], (row[1] or "").strip()
        if not d or not acct:
            continue
        day = date.fromisoformat(d)
        if acct not in out or day < out[acct]:
            out[acct] = day
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument(
        "--order-only",
        action="store_true",
        help="只用订单日期，不与账号表登记日取早（默认取早）",
    )
    args = ap.parse_args()

    engine = create_engine(get_settings().alembic_url)
    sheet = {} if args.order_only else sheet_dates()

    with engine.begin() as conn:
        rows = conn.execute(text(SOURCE_SQL)).all()
        matched = [r for r in rows if r[4] is not None]
        orphan = [r for r in rows if r[4] is None]
        print(f"库存 {len(rows)} 个 → 有来源订单 {len(matched)} 个 | 无来源订单 {len(orphan)} 个")
        for r in orphan:
            print(f"  无来源订单: {r[1]} {r[2]}")

        plan = []
        from_sheet = 0
        for r in matched:
            order_day = r[6]
            sd = sheet.get((r[2] or "").strip())
            if sd is not None and sd < order_day:
                target, src = sd, "账号表登记日"
                from_sheet += 1
            else:
                target, src = order_day, "订单日"
            plan.append({**dict(zip(("id", "stock_no", "acct", "cur", "order_no", "otype", "order_day"), r)),
                         "target": target, "src": src})

        changed = [p for p in plan if str(p["cur"])[:10] != str(p["target"])]
        print(f"需要改动 {len(changed)} 个 | 其中取账号表登记日 {from_sheet} 个")
        print("现有分布:", Counter(str(p["cur"])[:10] for p in plan).most_common(3))
        print("改后范围:", min(p["target"] for p in plan), "~", max(p["target"] for p in plan))

        print("\n改动明细：")
        for p in changed:
            print(
                f"  {p['stock_no']} {p['acct']:>18s} {str(p['cur'])[:10]} → {p['target']}"
                f" ({p['src']}, {p['order_no']})"
            )

        if not args.apply:
            print("\n[dry-run] 未写库。加 --apply 执行。")
            return

        for p in plan:
            conn.execute(
                text("update stocks set inventory_entry_at = cast(:d as timestamp) where id = :i"),
                {"d": str(p["target"]), "i": p["id"]},
            )
        print(f"\n已回填入库时间：{len(plan)} 个库存")


if __name__ == "__main__":
    main()
