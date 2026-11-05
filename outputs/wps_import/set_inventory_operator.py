"""补录库存来源订单的入库负责人（form_extra.business_responsible_ids）。

只处理 WPS 补录的在库单；不改金额、不改日期、不改库存状态。
默认 dry-run，--apply 才写库。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import create_engine, text

from app.core.settings import get_settings

# 库存号 -> (订单号, 负责人用户 id 列表)
MAPPING = {
    "KU_00087": ("HS0052", [1]),   # 三三
    "KU_00088": ("HS0053", [1]),   # 三三
}

BACKUP = Path(__file__).with_name("bak_set_inventory_operator_20261101-2310.json")

SQL_READ = """
select o.id, o.order_no, o.form_extra::text, s.stock_no, s.game_account
from orders o join stocks s on s.id = o.account_id
where o.order_no = :ono
"""

SQL_WRITE = """
update orders
   set form_extra = (
         coalesce(nullif(form_extra::text, 'null'), '{}')::jsonb
         || jsonb_build_object('business_responsible_ids', cast(:ids as jsonb))
       )::json
 where id = :oid
"""


def main() -> None:
    apply = "--apply" in sys.argv
    eng = create_engine(get_settings().alembic_url)

    with eng.connect() as c:
        names = {
            r[0]: (r[1] or r[0])
            for r in c.execute(text("select id, display_name from users"))
        }
        rows = []
        for sno, (ono, ids) in MAPPING.items():
            r = c.execute(text(SQL_READ), {"ono": ono}).first()
            if r is None:
                print(f"  !! {sno} 找不到订单 {ono}，跳过")
                continue
            rows.append(
                {
                    "oid": r[0],
                    "order_no": r[1],
                    "form_extra": r[2],
                    "stock_no": r[3],
                    "game_account": r[4],
                    "ids": ids,
                    "names": "、".join(names.get(i, f"#{i}") for i in ids),
                }
            )

    print(f"待写 {len(rows)} 单：")
    for x in rows:
        print(
            f"  {x['stock_no']} {x['game_account']:>12s} {x['order_no']} "
            f"→ 入库负责人 {x['names']}  (form_extra 现值 {x['form_extra']})"
        )

    if not apply:
        print("\n[dry-run] 加 --apply 写库")
        return

    if not BACKUP.exists():
        BACKUP.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n备份已写 {BACKUP.name}")

    with eng.begin() as c:
        for x in rows:
            n = c.execute(
                text(SQL_WRITE), {"ids": json.dumps(x["ids"]), "oid": x["oid"]}
            ).rowcount
            print(f"  {x['order_no']} 更新 {n} 行")

    with eng.connect() as c:
        print("\n复核：")
        for x in rows:
            v = c.execute(
                text("select form_extra::text from orders where id = :i"), {"i": x["oid"]}
            ).scalar()
            print(f"  {x['order_no']} → {v}")


if __name__ == "__main__":
    main()
