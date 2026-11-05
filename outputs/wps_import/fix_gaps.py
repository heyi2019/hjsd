"""补录 WPS 导入遗留的三类数据（按 2026-11-01 用户裁决的口径）。

1) 7 单「氪金联盟提号」本金为 0 —— 口径：这是 TH 订单，来源合作方氪金联盟。
   本金按「成交额 − 利润」推定（提号是过手：买家付款 − 付给氪金联盟 = 留利），
   补建库存账号（DISTRIBUTION/PICKUP）+ TH 单（关联合作方 SUPPLIER）+ 买入/卖出事件。

2) 10-14「违约金」单（成交 1,030 / 利润 51.5）—— 口径：只记 51.5 违约金收入，不建库存。

3) 29 条返点 + 1 条打赏 —— 口径：返点是收入、打赏是支出。
   全部独立流水记入利润池，不挂订单（已实测 0/30 可与订单配对）。

用法：
    python fix_gaps.py            # dry-run
    python fix_gaps.py --apply    # 写库
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.core.security import CurrentUser  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain.parties import Counterparty  # noqa: E402
from app.finance import cashflows as cashflow_service  # noqa: E402
from app.orders import service as orders_service  # noqa: E402
from app.parties import counterparties as cp_service  # noqa: E402
from app.stocks import service as stocks_service  # noqa: E402

P_INVEST, P_PROFIT = 1, 2
ACTOR = "wps-import"
MARK = "WPS补录"

# 7 单零本金 TH：日期 / 成交额 / 利润
ZERO_TH = [
    ("2026-09-05", "700", "157"),
    ("2026-09-19", "254", "34"),
    ("2026-09-25", "463", "82.3"),
    ("2026-10-12", "1154", "174"),
    ("2026-10-13", "375", "30"),
    ("2026-10-27", "1488", "390"),
    ("2026-10-28", "6388", "888"),
]

PENALTY = {"date": "2026-10-14", "amount": "51.5", "note": "违约金（WPS 10-14 回收单，成交 1030 含退款）"}

# 29 条返点：日期 / 返点额 / 原始备注
REBATES = [
    ("2026-09-07", "21.5", "螃蟹430收号返点"),
    ("2026-09-08", "28.61", "盼之475.1收号返点"),
    ("2026-08-25", "470", ""),
    ("2026-08-24", "27", ""),
    ("2026-08-29", "10", ""),
    ("2026-09-16", "63", ""),
    ("2026-09-20", "11", ""),
    ("2026-09-27", "87.11", "盼之首保6%返点"),
    ("2026-09-27", "27.1", "盼之续保3%返点"),
    ("2026-09-27", "81.11", "盼之首保6%返点"),
    ("2026-09-28", "43.61", "盼之首保6%返点"),
    ("2026-09-30", "13", ""),
    ("2026-10-01", "36.11", "盼之首保6%返点"),
    ("2026-09-30", "69.11", "盼之首保6%返点"),
    ("2026-09-30", "81.11", "盼之首保6%返点"),
    ("2026-10-01", "57.11", "盼之首保6%返点"),
    ("2026-10-02", "55", ""),
    ("2026-10-02", "62.5", "千寻续保5%返点"),
    ("2026-10-03", "21", "螃蟹收号5%返点"),
    ("2026-10-08", "79.5", "螃蟹收号3%续保返点"),
    ("2026-10-11", "45.7", ""),
    ("2026-10-11", "55", ""),
    ("2026-10-13", "30.6", "盼之收号6%首保返点"),
    ("2026-10-13", "72", "盼之和平收款首保6个点"),
    ("2026-10-14", "90", "盼之和平首保6个点"),
    ("2026-10-16", "18", ""),
    ("2026-10-24", "31.5", ""),
    ("2026-10-27", "18.1", ""),
    ("2026-10-20", "38.5", ""),
]

TIP = {"date": "2026-10-09", "amount": "188", "note": "客户打赏（WPS 10-09 打赏）"}


def ensure_supplier(session: Session) -> Counterparty:
    """氪金联盟既是提号来源，就把 CP0001 正名为「氪金联盟」。"""
    cp = session.scalar(select(Counterparty).where(Counterparty.counterparty_no == "CP0001"))
    if cp is None:
        raise RuntimeError("CP0001 不存在，需先建氪金联盟合作方")
    return cp


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    session = get_session_factory(get_settings().alembic_url)()
    admin = CurrentUser.build(id=1, username="admin", roles=("ADMIN",), owner_scope="ALL", pool_ids=(1, 2))
    try:
        cp = ensure_supplier(session)
        print(f"合作方：{cp.counterparty_no} 当前名称「{cp.display_name}」 type={cp.type} status={cp.status}")
        if cp.display_name != "氪金联盟":
            print("  -> 计划更名为「氪金联盟」")

        print()
        print("=== 7 单零本金 TH（本金按成交−利润推定）===")
        total_principal = Decimal("0")
        for i, (d, amount, profit) in enumerate(ZERO_TH, start=1):
            principal = Decimal(amount) - Decimal(profit)
            total_principal += principal
            exists = session.execute(
                text("select count(*) from orders where trade_date=:d and order_type='TH' and note like :m"),
                {"d": d, "m": f"%{MARK}%"},
            ).scalar()
            print(
                f"  {d} 成交 {Decimal(amount):>8} 利润 {Decimal(profit):>7} 推定本金 {principal:>8}"
                f"  {'已存在，跳过' if exists else '新建'}"
            )
        print(f"  推定本金合计 {total_principal}")

        print()
        print(f"=== 违约金收入 === {PENALTY['date']} {PENALTY['amount']} 进利润池（不建库存）")
        print()
        print(f"=== 返点 {len(REBATES)} 条（收入，进利润池）===")
        reb_total = sum(Decimal(x[1]) for x in REBATES)
        print(f"  合计 {reb_total}")
        print(f"=== 打赏 1 条（支出，从利润池出）=== {TIP['amount']}")
        print(f"  净影响利润池 {reb_total + Decimal(PENALTY['amount']) - Decimal(TIP['amount'])}")

        if not args.apply:
            print("\ndry-run 结束。加 --apply 才写库。")
            return

        # ---- 1) 合作方正名 ----
        if cp.display_name != "氪金联盟":
            cp_service.update_counterparty(
                session, cp.id, actor=ACTOR, display_name="氪金联盟",
                note="TH 提号来源渠道；WPS 历史导入时由测试名 10000 更名",
            )
            print(f"合作方已更名：CP0001 -> 氪金联盟")

        # ---- 2) 7 单 TH ----
        for i, (d, amount, profit) in enumerate(ZERO_TH, start=1):
            amount_d, profit_d = Decimal(amount), Decimal(profit)
            day = date.fromisoformat(d)
            exists = session.execute(
                text("select count(*) from orders where trade_date=:d and order_type='TH' and note like :m"),
                {"d": d, "m": f"%{MARK}%"},
            ).scalar()
            if exists:
                print(f"跳过已存在 {d} 成交 {amount_d}")
                continue
            principal = amount_d - profit_d
            with session.begin_nested():
                acct = stocks_service.create_account(
                    session, game_account=f"WPS-{d}-TH{i}", actor=ACTOR,
                    business_mode="DISTRIBUTION", inventory_type="PICKUP",
                    note="WPS补录：提号零本金单，账号待补",
                )
                session.flush()
                order = orders_service.create_order(
                    session, order_type="TH", trade_date=day, actor=ACTOR,
                    account_id=acct.id, note=f"{MARK} 氪金联盟提号 成交{amount_d:,.2f} 利润{profit_d:,.2f}",
                    counterparty_roles=[(cp.id, "PEER")], user=admin,
                )
                session.flush()
                orders_service.post_event(
                    session, order.id, event_type="BUY", amount=principal,
                    occurred_on=day, actor=ACTOR, pool_id=P_INVEST,
                    portion="PRINCIPAL", user=admin,
                )
                orders_service.post_event(
                    session, order.id, event_type="SELL", amount=principal,
                    occurred_on=day, actor=ACTOR, pool_id=P_INVEST,
                    pool_id2=P_PROFIT, amount2=profit_d,
                    portion="PROFIT", user=admin,
                )
                print(f"建单 {order.order_no} {d} 本金 {principal} 利润 {profit_d}")

        # ---- 3) 违约金收入 ----
        cashflow_service.create_cashflow(
            session, pool_id=P_PROFIT, occurred_on=date.fromisoformat(PENALTY["date"]),
            direction="IN", nature="BUSINESS_IN", category="PENALTY",
            accounting_attribute="SELF_REVENUE",
            amount=Decimal(PENALTY["amount"]), actor=ACTOR, note=PENALTY["note"],
        )
        print(f"违约金收入 {PENALTY['amount']} 已入账")

        # ---- 4) 返点收入 ----
        for d, amount, original in REBATES:
            note = f"{MARK} 返点" + (f" | {original}" if original else "")
            cashflow_service.create_cashflow(
                session, pool_id=P_PROFIT, occurred_on=date.fromisoformat(d),
                direction="IN", nature="BUSINESS_IN", category="REBATE",
                amount=Decimal(amount), actor=ACTOR, note=note,
            )
        print(f"返点 {len(REBATES)} 条已入账")

        # ---- 5) 打赏支出 ----
        cashflow_service.create_cashflow(
            session, pool_id=P_PROFIT, occurred_on=date.fromisoformat(TIP["date"]),
            direction="OUT", nature="BUSINESS_OUT", category="TIP",
            amount=Decimal(TIP["amount"]), actor=ACTOR, note=TIP["note"],
        )
        print(f"打赏支出 {TIP['amount']} 已入账")

        session.commit()
        print("\n提交完成。")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
