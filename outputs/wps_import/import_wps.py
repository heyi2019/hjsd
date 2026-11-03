"""WPS「黑金时代工作室」订单表 -> 黑金时代 ERP 导入。

用法：
  python import_wps.py                # dry-run，只打印计划，不写库
  python import_wps.py --apply        # 执行导入（不清库）
  python import_wps.py --apply --reset  # 先清空业务数据再导入

口径（2026-11-01 裁决）：
  - 回收 -> HS；氪金联盟提号 -> TH；代挂/蹭点 -> DG
  - 代挂若我方垫付本金（本金>0）-> 改判 HS（回收口径）
  - 返点、打赏不是订单，跳过
  - HS/TH：BUY(本金) + SELL(本金回投资池 / 利润进利润池)
  - DG：SELL(佣金) 进利润池，成交额写备注
  - 订单表无账号 -> 用「回收账号登记」按 (本金,交易金额) 匹配，匹配不上建占位账号
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
sys.path.insert(0, str(BACKEND))

from sqlalchemy import text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.core.security import CurrentUser  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.orders import service as orders_service  # noqa: E402
from app.stocks import service as stocks_service  # noqa: E402

BASE = Path(__file__).parent
P_INVEST, P_PROFIT = 1, 2  # HJ_INVEST / HJ_PROFIT
ACTOR = "wps-import"

TYPE_MAP = {"回收": "HS", "氪金联盟提号": "TH", "代挂": "DG", "蹭点": "DG"}
# HS/TH 需要账号；DG 零本金不需要
ACCOUNT_MODE = {"HS": ("SELF", "RECOVERY"), "TH": ("DISTRIBUTION", "PICKUP")}

# 回收账号登记（日期, 账号, 回收金额, 售卖金额）
ACCOUNTS_RAW = """
2026-07-17,2762328846,670,1135.6
2026-07-18,1992729136,2100,2800
2026-07-21,1985078801,3769.5,4600
2026-07-22,2799975037,700,850
2026-07-24,2939415472,1400,2000
2026-07-25,3420662122,373,588
2026-07-26,3268553668,762,900
2026-07-26,2905306331,730,1088
2026-07-28,1936514685,649.6,900
2026-07-29,3140627724,3475,3950
2026-08-06,203958830,1480,2188
2026-08-13,2402130006,745,888
2026-08-13,286319254,14710,15888
2026-08-14,2565047035,12010,15000
2026-08-24,3409500495,577,1088
2026-08-25,390142757,10350,10888
2026-08-27,Yy04_03y,10200,10888
2026-08-28,2498882476,448,788
2026-08-29,OvO-arii5,220,688
2026-09-07,3517076857,461.5,688
2026-09-07,3624724541,504,888
2026-09-16,1705163681,1000,1388
2026-09-19,1641306510,252,588
2026-09-22,3316387738,1605.11,2288
2026-09-25,1261684667,529.2,580
2026-09-26,188913591,807.61,1388
2026-09-26,3075822516,1000.11,1288
2026-09-26,1040453871,1495.11,2100
2026-09-29,318541549,1000,1158
2026-09-29,2217163792,1495.11,2350
2026-09-30,3859836460,296,588
2026-09-30,2187558826,1275.11,1788
2026-10-01,3556864402,660.11,1280
2026-10-01,3226801808,1050.11,1680
2026-10-02,3541540286,688,1588
2026-10-02,3191349609,1385,1800
2026-10-03,2895717492,472,888
2026-10-04,749642474,593,888
2026-10-07,3453308860,2925,3588
2026-10-11,1879456551,1500.1,2288
2026-10-13,477241574,1200.1,1788
2026-10-13,2762628860,571.11,1200
2026-10-16,2177296797,406,688
2026-10-20,,615,1288
2026-10-24,2260589737,505,888
2026-10-25,2037343914,340,1488
,2762628860,500,1088
"""


def load_accounts() -> list[dict]:
    out = []
    for line in ACCOUNTS_RAW.strip().splitlines():
        parts = line.split(",")
        if len(parts) != 4:
            continue
        d, acct, buy, sell = (p.strip() for p in parts)
        out.append(
            {"date": d, "account": acct, "buy": float(buy), "sell": float(sell)}
        )
    return out


def resolve_type(raw: str, principal: float) -> str | None:
    if raw in ("返点", "打赏"):
        return None
    if raw in ("代挂", "蹭点") and principal > 0:
        return "HS"
    return TYPE_MAP.get(raw)


def build_plan(rows: list[dict], accounts: list[dict]) -> tuple[list[dict], list[dict]]:
    plan, skipped = [], []
    used: set[int] = set()
    for idx, r in enumerate(rows):
        code = resolve_type(r["order_type_raw"], r["principal"])
        if code is None:
            skipped.append({**r, "reason": "非订单（返点/打赏）"})
            continue
        item = {**r, "code": code, "account": None, "placeholder": False}
        if code in ACCOUNT_MODE:
            # 三级匹配：①售卖与本金都近似 ②仅售卖近似 ③仅本金近似；同级取日期最近
            def score(a: dict) -> int:
                s_sell = abs(a["sell"] - r["amount"]) <= 1
                s_buy = abs(a["buy"] - r["principal"]) <= 1
                if s_sell and s_buy:
                    return 3
                if s_sell:
                    return 2
                if s_buy:
                    return 1
                return 0

            cands = [(i, a, score(a)) for i, a in enumerate(accounts) if i not in used]
            cands = [c for c in cands if c[2] > 0]
            if cands:
                def day_gap(a: dict) -> int:
                    if not a["date"]:
                        return 999
                    return abs(
                        (date.fromisoformat(a["date"]) - date.fromisoformat(r["date"])).days
                    )

                cands.sort(key=lambda x: (-x[2], day_gap(x[1])))
                i, a, _ = cands[0]
                used.add(i)
                item["account"] = a["account"] or f"WPS-{r['date']}-{idx + 1}"
                item["placeholder"] = not a["account"]
            else:
                item["account"] = f"WPS-{r['date']}-{idx + 1}"
                item["placeholder"] = True
        plan.append(item)
    return plan, skipped


def reset_business_data(db) -> None:
    order = [
        "cashflow", "order_events", "order_profit_allocations",
        "order_customer_roles", "order_counterparty_roles", "order_links",
        "rebate_settlements", "rebate_records", "installment_dispositions",
        "installment_schedules", "installments", "orders", "stocks",
        "quality_issues", "notifications", "attachments", "reconciliations",
        "deposits", "customer_leads", "import_rows", "import_batches",
        "audit_logs",
    ]
    for t in order:
        db.execute(text(f'DELETE FROM "{t}"'))
    db.execute(text("UPDATE document_sequences SET current_value = 0"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写库")
    ap.add_argument("--reset", action="store_true", help="先清空业务数据")
    args = ap.parse_args()

    rows = json.loads((BASE / "wps_orders.json").read_text())
    accounts = load_accounts()
    plan, skipped = build_plan(rows, accounts)
    matched = sum(1 for p in plan if p["account"] and not p["placeholder"])
    ph = sum(1 for p in plan if p["placeholder"])

    print(f"源数据 {len(rows)} 行 | 建单 {len(plan)} | 跳过 {len(skipped)}")
    print(f"账号匹配 {matched} 单 | 占位账号 {ph} 单")
    for code in ("HS", "TH", "DG"):
        sub = [p for p in plan if p["code"] == code]
        print(
            f"  {code}: {len(sub):3d} 单  交易 {sum(p['amount'] for p in sub):>11,.2f}"
            f"  本金 {sum(p['principal'] for p in sub):>11,.2f}"
            f"  利润 {sum(p['profit'] for p in sub):>10,.2f}"
        )
    if not args.apply:
        print("\n[dry-run] 未写库。加 --apply 执行。")
        (BASE / "import_plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1))
        return

    Session = get_session_factory(get_settings().alembic_url)
    db = Session()
    admin = CurrentUser.build(id=1, username="admin", roles=("ADMIN",), owner_scope="ALL")
    try:
        if args.reset:
            reset_business_data(db)
            db.flush()
            print("\n已清空业务数据（配置表保留）")

        stat = {"ok": 0, "fail": 0, "skip": 0}
        fails: list[str] = []
        for p in plan:
            d = date.fromisoformat(p["date"])
            # 本金缺失的 HS/TH 无法回放采购入库，不猜数，留给人工补
            if p["code"] in ("HS", "TH") and float(p["principal"]) <= 0:
                stat["skip"] += 1
                fails.append(f"{p['date']} {p['order_type_raw']} {p['amount']}: 本金为 0，无法回放入库，待补本金")
                continue
            try:
                with db.begin_nested():
                    acct_id = None
                    if p["code"] in ACCOUNT_MODE:
                        mode, inv = ACCOUNT_MODE[p["code"]]
                        note_bits = ["WPS 历史导入"]
                        if p["placeholder"]:
                            note_bits.append("账号表未匹配到，占位待补")
                        acct = stocks_service.create_account(
                            db, game_account=p["account"], actor=ACTOR,
                            business_mode=mode, inventory_type=inv,
                            note="；".join(note_bits),
                        )
                        db.flush()
                        acct_id = acct.id

                    note = f"WPS导入 {p['order_type_raw']}"
                    if p["amount"] and p["profit"]:
                        note += f" 成交{p['amount']:,.2f} 利润{p['profit']:,.2f}"
                    if p["note"]:
                        note += f" | {p['note']}"
                    order = orders_service.create_order(
                        db, order_type=p["code"], trade_date=d, actor=ACTOR,
                        account_id=acct_id, note=note, user=admin,
                    )
                    db.flush()

                    principal = Decimal(str(p["principal"]))
                    profit = Decimal(str(p["profit"]))
                    amount = Decimal(str(p["amount"]))
                    if p["code"] in ("HS", "TH") and principal > 0:
                        orders_service.post_event(
                            db, order.id, event_type="BUY", amount=principal,
                            occurred_on=d, actor=ACTOR, pool_id=P_INVEST,
                            portion="PRINCIPAL", user=admin,
                        )
                    if p["code"] == "DG":
                        if profit > 0:
                            orders_service.post_event(
                                db, order.id, event_type="SELL", amount=profit,
                                occurred_on=d, actor=ACTOR, pool_id=P_PROFIT,
                                portion="PROFIT", user=admin,
                            )
                    else:
                        # 本金必然回笼：售价拆为本金（回投资池）+ 利润（进利润池）。
                        # WPS「回款账户」只反映记录习惯，不作为资金路由依据。
                        if profit > 0:
                            orders_service.post_event(
                                db, order.id, event_type="SELL", amount=principal,
                                occurred_on=d, actor=ACTOR, pool_id=P_INVEST,
                                pool_id2=P_PROFIT, amount2=profit,
                                portion="PROFIT", user=admin,
                            )
                        else:
                            # 亏损单：SELL = 本金 + 负利润，缺口由投资池承担。
                            # 系统按「利润 = SELL - BUY」算，若仍记本金会把亏损抹平成 0。
                            realized = principal + profit
                            if realized <= 0:
                                raise ValueError(
                                    f"亏损额 {profit} 使回笼金额 {realized} 非正，需人工处理"
                                )
                            orders_service.post_event(
                                db, order.id, event_type="SELL", amount=realized,
                                occurred_on=d, actor=ACTOR, pool_id=P_INVEST,
                                portion="PROFIT", user=admin,
                            )
                    stat["ok"] += 1
            except Exception as exc:  # 单笔失败不阻断整批
                stat["fail"] += 1
                fails.append(f"{p['date']} {p['order_type_raw']} {p['amount']}: {type(exc).__name__} {exc}")
        db.commit()
        print(f"\n导入完成：成功 {stat['ok']} 单，失败 {stat['fail']} 单")
        for f in fails[:15]:
            print("  FAIL", f)

        print("\n=== 落库校验 ===")
        for r in db.execute(text(
            "select p.code, coalesce(sum(case when c.direction='IN' then c.amount else -c.amount end),0) "
            "from pools p left join cashflow c on c.pool_id=p.id group by p.id order by p.id"
        )):
            print("  池余额:", r)
        for r in db.execute(text(
            "select order_type, count(*), sum(amount) from ("
            " select o.order_type, e.amount from orders o"
            " left join order_events e on e.order_id=o.id and e.event_type='SELL') t"
            " group by order_type order by order_type"
        )):
            print("  订单:", r)
        print("  库存账号:", db.execute(text("select count(*) from stocks")).scalar())
        print("  流水笔数:", db.execute(text("select count(*) from cashflow")).scalar())
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
