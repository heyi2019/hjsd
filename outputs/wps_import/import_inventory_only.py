"""补录 WPS 账号表中「已售=否」的在库未售账号。

背景：ERP 的库存由订单 BUY 事件生成，但这批号收进来后没卖，订单表里没有成交行，
因此从未入库，库存中心显示在库 0。账号表明确标「已售=否」，属真实在库资产。

做法：每个号建一张 HS 回收单，只发 BUY 事件、不发 SELL：
  - 订单状态 ACTIVE（未完成）
  - 库存 status=WAITING / inventory_status=IN_STOCK（Account.status 监听自动同步）
  - BUY 支出进投资款池（池1），成本即账号表「回收金额」

入库时间按「取早」口径回填为账号表登记日。

用法：
    python3 import_inventory_only.py            # dry-run
    python3 import_inventory_only.py --apply    # 执行
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, time
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy import select  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.core.security import CurrentUser  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain.trade_models.order import Order  # noqa: E402
from app.domain.trade_models.account import Account  # noqa: E402
from app.orders import service as orders_service  # noqa: E402
from app.stocks import service as stocks_service  # noqa: E402
from wps_people import META, ROWS  # noqa: E402

ACTOR = "wps-import"
P_INVEST = 1
BACKUP = Path(__file__).with_name("bak_inventory_only_20261101-2310.json")

# 登记人昵称码 → users.id（用户裁决的昵称映射；N=未填，不猜）
NICK_TO_UID = {
    "E": [1],   # 企业用户_1210076649 → 三三
    "L": [7],   # 生活也会如你所期 → 吉祥
    "J": [2],   # 蒋丞选手 → 小轩
    "H": [4],   # 何邑 → 何一
    "A": [6],   # A-呆呆猫 → 凯文
    "N": [],    # 未填
}

# 已在 ERP 里建过库存并卖出（账号表标未售但订单表有成交）→ 不重复入库
SKIP = {"3191349609", "286319254", "2762628860"}


def build_plan() -> list[dict]:
    plan = []
    for d, acct, buy, sell, sold, code in ROWS:
        acct = (acct or "").strip()
        if str(sold).strip() != "否" or not acct or acct in SKIP:
            continue
        cost = D(str(buy or 0))
        if cost <= 0:
            continue
        plan.append(
            {
                "date": d,
                "account": acct,
                "cost": str(cost),
                "list_price": str(D(str(sell or 0))),
                "nick": META[code][0],
                "user_ids": NICK_TO_UID.get(code, []),
            }
        )
    return plan


def main(apply: bool) -> None:
    plan = build_plan()
    total = sum(D(p["cost"]) for p in plan)
    print(f"在库未售待补 {len(plan)} 个，成本合计 {total}\n")
    print(f"{'日期':12s} {'账号':>14s} {'回收成本':>10s} {'挂价':>9s} {'登记人':<10s} {'负责人uid'}")
    for p in plan:
        print(
            f"{p['date'] or '无日期':12s} {p['account']:>14s} {p['cost']:>10s} "
            f"{p['list_price']:>9s} {p['nick']:<10s} {p['user_ids'] or '（未填，留空）'}"
        )

    Session = get_session_factory(get_settings().alembic_url)
    db = Session()
    try:
        # 幂等：已存在的账号先剔除
        exists = {
            a for a in db.scalars(
                select(Account.game_account).where(
                    Account.game_account.in_([p["account"] for p in plan])
                )
            ).all()
        }
        if exists:
            print(f"\n已存在同名库存，跳过：{sorted(exists)}")
            plan = [p for p in plan if p["account"] not in exists]

        if not apply:
            print(f"\n[dry-run] 将新建 {len(plan)} 张 HS 回收单（只发 BUY），"
                  f"池1 支出 {sum(D(p['cost']) for p in plan)}。未写库，加 --apply 执行。")
            (Path(__file__).parent / "inventory_only_plan.json").write_text(
                json.dumps(plan, ensure_ascii=False, indent=1)
            )
            return

        if BACKUP.exists():
            raise SystemExit(f"备份已存在 {BACKUP}，避免覆盖，先移走再执行")
        snap: dict[str, list] = {}
        from sqlalchemy import text as _sql
        for tbl in ("orders", "stocks", "order_events", "cashflow"):
            snap[tbl] = [
                dict(r._mapping) for r in db.execute(_sql(f"select * from {tbl}")).all()
            ]
        BACKUP.write_text(json.dumps(snap, ensure_ascii=False, indent=1, default=str))
        print(f"\n已备份 {'/'.join(snap)} 共 {sum(len(v) for v in snap.values())} 行 → {BACKUP.name}")

        admin = CurrentUser.build(
            id=1, username="admin", roles=("ADMIN",), owner_scope="ALL", pool_ids=(1, 2)
        )
        ok, fails = 0, []
        for p in plan:
            d = date.fromisoformat(p["date"]) if p["date"] else date.today()
            cost = D(p["cost"])
            try:
                with db.begin_nested():
                    acct = stocks_service.create_account(
                        db,
                        game_account=p["account"],
                        actor=ACTOR,
                        business_mode="SELF",
                        inventory_type="RECOVERY",
                        note="WPS 账号表「已售=否」补录，在库未售",
                    )
                    db.flush()
                    note = (
                        f"WPS账号表补录 在库未售 回收{cost:,.2f}"
                        f" 挂价{D(p['list_price']):,.2f}"
                        + ("" if p["user_ids"] else " | 账号表未填登记人")
                    )
                    form_extra = (
                        {"business_responsible_ids": p["user_ids"]} if p["user_ids"] else None
                    )
                    order = orders_service.create_order(
                        db,
                        order_type="HS",
                        trade_date=d,
                        actor=ACTOR,
                        account_id=acct.id,
                        note=note,
                        form_extra=form_extra,
                        user=admin,
                    )
                    db.flush()
                    orders_service.post_event(
                        db,
                        order.id,
                        event_type="BUY",
                        amount=cost,
                        occurred_on=d,
                        actor=ACTOR,
                        pool_id=P_INVEST,
                        portion="PRINCIPAL",
                        operator_user_ids=p["user_ids"] or None,
                        user=admin,
                    )
                    # 入库时间按「取早」口径回到账号表登记日
                    acct.inventory_entry_at = datetime.combine(d, time.min)
                    ok += 1
                    print(f"  OK {acct.stock_no} {p['account']} → {order.order_no} 成本 {cost}")
            except Exception as exc:  # 单笔失败不阻断整批
                fails.append(f"{p['date']} {p['account']}: {type(exc).__name__} {exc}")
        db.commit()
        print(f"\n完成：成功 {ok}，失败 {len(fails)}")
        for f in fails:
            print("  FAIL", f)
    finally:
        db.close()


if __name__ == "__main__":
    main("--apply" in sys.argv)
