"""把「入库负责人」回填到订单 form_extra.business_responsible_ids。

背景（2026-11-01 用户纠正）：
  库存中心的「入库负责人」列 = inventory_operator，后端取来源订单的
  form_extra.business_responsible_ids；取不到才回退 account.created_by。
  WPS 导入时 form_extra 全为 null，所以 81 行全显示 wps-import。

口径（入库负责人在三种业务里是同一个概念，只是标签不同）：
  HS 回收  -> 回收负责人 = BUY 事件 operator_user_ids
  TH 提号  -> 提号负责人 = BUY 事件 operator_user_ids
  DG 代挂  -> 代挂负责人 = 建单/SELL 事件 operator_user_ids（DG 无库存账号，仅补订单）
  多人共同经手则全填，顺序与事件一致。

附带清理：stocks.note 里此前误加的「；回收人：X」文字（写错了位置，备注列不参与展示逻辑）。

用法：
    python backfill_inventory_operator.py            # dry-run
    python backfill_inventory_operator.py --apply    # 写库
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import create_engine, text  # noqa: E402

from app.core.settings import get_settings  # noqa: E402

NOTE_OWNER = re.compile(r"[；;]?\s*回收人：[^；;]*")


def fetch_plan(conn) -> list[dict]:
    """每单一条：来源订单 + 应填入库负责人。"""
    rows = conn.execute(
        text(
            """
            select o.id, o.order_no, o.order_type, s.stock_no, s.game_account,
                   e.operator_user_ids
            from orders o
            left join stocks s on s.id = o.account_id
            join order_events e on e.order_id = o.id and e.is_posted = true
            where (o.order_type in ('HS','TH') and e.event_type = 'BUY')
               or (o.order_type = 'DG' and e.event_type = 'SELL')
            order by o.order_type, o.id
            """
        )
    )
    names = {
        r[0]: r[1] or r[2]
        for r in conn.execute(text("select id, display_name, username from users"))
    }
    plan = []
    for r in rows:
        m = r._mapping
        raw = m["operator_user_ids"] or []
        ids = [int(x) for x in raw if isinstance(x, int) and x > 0]
        if isinstance(raw, str):
            try:
                ids = [int(x) for x in json.loads(raw) if int(x) > 0]
            except Exception:
                ids = []
        plan.append(
            {
                "order_id": m["id"],
                "order_no": m["order_no"],
                "order_type": m["order_type"],
                "stock_no": m["stock_no"],
                "game_account": m["game_account"],
                "ids": ids,
                "names": [names.get(i, f"#{i}") for i in ids],
            }
        )
    return plan


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    engine = create_engine(get_settings().alembic_url)
    with engine.begin() as conn:
        plan = fetch_plan(conn)
        have = [p for p in plan if p["ids"]]
        missing = [p for p in plan if not p["ids"]]
        print(f"订单 {len(plan)} 单 → 可回填入库负责人 {len(have)} 单 | 无操作人 {len(missing)} 单")
        for code in ("HS", "TH", "DG"):
            sub = [p for p in plan if p["order_type"] == code]
            print(f"  {code}: {len(sub):3d} 单，其中有操作人 {sum(1 for p in sub if p['ids'])}")
        if missing:
            for p in missing:
                print(f"    无操作人: {p['order_no']} {p['order_type']} {p['stock_no'] or ''}")

        dist = Counter("、".join(p["names"]) for p in have)
        print("\n入库负责人分布:")
        for k, v in dist.most_common():
            print(f"  {k or '(空)':12s} {v} 单")

        note_cnt = conn.execute(
            text("select count(*) from stocks where note like '%回收人：%'")
        ).scalar()
        print(f"\n待清理 note 中「回收人：X」文字：{note_cnt} 个库存")

        if not args.apply:
            print("\n[dry-run] 未写库。加 --apply 执行。")
            return

        ok = 0
        for p in have:
            conn.execute(
                text(
                    """
                    update orders
                       set form_extra = (
                             case
                               when form_extra is null or form_extra::text in ('null', '{}')
                                 then '{}'::jsonb
                               else form_extra::jsonb
                             end
                             || jsonb_build_object('business_responsible_ids', cast(:ids as jsonb))
                           )::json
                     where id = :i
                    """
                ),
                {"ids": json.dumps(p["ids"]), "i": p["order_id"]},
            )
            ok += 1
        print(f"\n已回填 form_extra.business_responsible_ids：{ok} 单")

        cleaned = 0
        for r in conn.execute(
            text("select id, note from stocks where note like '%回收人：%'")
        ).all():
            new = NOTE_OWNER.sub("", r[1] or "").strip(" ；;")
            conn.execute(
                text("update stocks set note = :n where id = :i"), {"n": new or None, "i": r[0]}
            )
            cleaned += 1
        print(f"已清理 note 误写文字：{cleaned} 个库存")
        print("\n提交完成。")


if __name__ == "__main__":
    main()
