"""补录 WPS 账号表里两个「未售、未付款」的在库账号。

用户 2026-11-02 裁决：958188038（回收 692）与 2762628860 第二笔（回收 500）
都是「未付，只建库存」。两笔均未出现在「个人记账明细」的账号回收类里，
说明钱还没走出去。

做法：
  1. 建 HS 回收单，只发 BUY 事件（不建 SELL）；
  2. BUY 会派生一条支出流水，把该流水状态改为 PENDING（待审核）——
     系统余额与报表一律只统计 APPROVED，故资金池不受影响；
  3. 库存 cost_amount 由 BUY 事件写入，资产侧账实相符；
  4. 将来实际付款后，只需审批这条待审核流水，无需再动订单与库存。

幂等：同账号同成本同日期已存在则跳过。
默认 dry-run，--apply 才提交。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, time
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import select, text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.core.security import CurrentUser  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
import app.domain.trade  # noqa: E402,F401  # 聚合注册全部交易模型
from app.domain.trade_models.account import Account  # noqa: E402
from app.domain.trade_models.cashflow import Cashflow  # noqa: E402
from app.orders import service as orders_service  # noqa: E402
from app.stocks.profile import create_account  # noqa: E402

ACTOR = "wps-import"
P_INVEST = 1
BACKUP = Path(__file__).with_name("bak_unpaid_inventory_20261102.json")

ITEMS = [
    {
        "account": "958188038",
        "cost": "692.00",
        "list_price": "1088.00",
        "day": "2026-11-01",
        "at": "2026-11-01T22:25:00",
        "desc": None,
    },
    {
        "account": "2762628860",
        "cost": "500.00",
        "list_price": "1088.00",
        "day": "2026-11-01",
        "at": "2026-11-01T23:59:00",
        "desc": (
            "💰1088 ⬆️⭐️安卓Q-V8精品小漂亮🈶紫瑶 3️⃣典藏2️⃣珍品传说 传说1️⃣5️⃣ "
            "🎨343皮肤 68级精英收藏家 营地：1854469161"
        ),
    },
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    db = get_session_factory(get_settings().alembic_url)()
    admin = CurrentUser.build(
        id=1, username="admin", roles=("ADMIN",), owner_scope="ALL", pool_ids=(1, 2)
    )

    todo = []
    for it in ITEMS:
        exists = db.scalar(
            select(Account.id).where(
                Account.game_account == it["account"],
                Account.cost_amount == D(it["cost"]),
                Account.buy_date == date.fromisoformat(it["day"]),
            )
        )
        if exists:
            print(f"  跳过（已存在同账号同成本）: {it['account']} {it['cost']}")
            continue
        todo.append(it)

    print(f"待补 {len(todo)} 个在库账号")
    for it in todo:
        print(
            f"  {it['day']} {it['account']:>12} 回收 {D(it['cost']):>8,.2f} "
            f"挂价 {D(it['list_price']):>9,.2f} → BUY 流水挂 PENDING"
        )

    if not args.apply:
        print("\ndry-run，未写库。加 --apply 执行。")
        return

    snap: dict[str, list] = {}
    for tbl in ("orders", "stocks", "order_events", "cashflow"):
        snap[tbl] = [dict(r._mapping) for r in db.execute(text(f"select * from {tbl}")).all()]
    BACKUP.write_text(json.dumps(snap, ensure_ascii=False, indent=1, default=str))
    print(f"\n已备份 → {BACKUP.name}")

    ok, fails = 0, []
    for it in todo:
        d = date.fromisoformat(it["day"])
        cost = D(it["cost"])
        try:
            with db.begin_nested():
                acct = create_account(
                    db,
                    game_account=it["account"],
                    actor=ACTOR,
                    business_mode="SELF",
                    inventory_type="RECOVERY",
                    account_description=it["desc"],
                    note="WPS 账号表补录：已收货、未付款，在库待售",
                )
                db.flush()
                note = (
                    f"WPS账号表补录 在库未售（未付款） 回收{cost:,.2f} "
                    f"挂价{D(it['list_price']):,.2f} | BUY 流水待审核，付款后审批"
                )
                order = orders_service.create_order(
                    db,
                    order_type="HS",
                    trade_date=d,
                    actor=ACTOR,
                    account_id=acct.id,
                    note=note,
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
                    user=admin,
                )
                db.flush()
                flows = db.scalars(
                    select(Cashflow).where(
                        Cashflow.order_id == order.id,
                        Cashflow.direction == "OUT",
                    )
                ).all()
                if not flows:
                    raise RuntimeError("BUY 未派生流水")
                for f in flows:
                    f.status = "PENDING"
                    f.note = "待付款：号已入库、款未付，付款后审批"
                acct.inventory_entry_at = datetime.fromisoformat(it["at"])
                ok += 1
                print(
                    f"  OK {acct.stock_no} {it['account']} → {order.order_no}"
                    f" 成本 {cost}，流水 {[f.flow_no for f in flows]} 置 PENDING"
                )
        except Exception as exc:  # noqa: BLE001 - 单笔失败不阻断
            fails.append(f"{it['account']}: {type(exc).__name__} {exc}")

    db.commit()
    print(f"\n完成：成功 {ok}，失败 {len(fails)}")
    for f in fails:
        print("  FAIL", f)


if __name__ == "__main__":
    main()
