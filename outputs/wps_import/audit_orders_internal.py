"""ERP 订单侧内部一致性审计（只读）。

A. 订单事件金额 vs 导入备注里的 WPS 原始口径（成交/本金/利润）
B. 事件派生流水合计 vs 事件金额
C. 订单状态 vs 库存状态
D. 账号重复入账、事件日期越界
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from decimal import Decimal

from sqlalchemy import text

sys.path.insert(0, "/Users/aries/黑金时代/backend")
from app.core.database import get_session_factory  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

NUM = r"([\d,]+\.\d{2}|[\d,]+)"
PAT_TOTAL = re.compile(rf"成交\s*{NUM}")
PAT_PROFIT = re.compile(rf"利润\s*{NUM}")


def money(s: str) -> Decimal:
    return Decimal(s.replace(",", ""))


def main() -> None:
    s = get_session_factory(get_settings().alembic_url)()

    rows = s.execute(
        text(
            """
            select o.id, o.order_no, o.order_type, o.trade_date, o.status, o.note,
                   coalesce((select sum(amount) from order_events e
                             where e.order_id=o.id and e.event_type='BUY'), 0) buy,
                   coalesce((select sum(amount) from order_events e
                             where e.order_id=o.id and e.event_type='SELL'), 0) sell,
                   coalesce((select sum(amount) from order_events e
                             where e.order_id=o.id and e.event_type='COST'), 0) cost,
                   (select count(*) from order_events e
                    where e.order_id=o.id and e.event_type='SELL') sell_cnt,
                   o.account_id
            from orders o order by o.order_no
            """
        )
    ).mappings().all()

    print(f"订单 {len(rows)} 笔")

    # ---------- A. 备注口径 vs 事件 ----------
    print("\n=== A. 成交额/利润 与备注不符 ===")
    bad_a = 0
    for r in rows:
        note = r["note"] or ""
        m_t, m_p = PAT_TOTAL.search(note), PAT_PROFIT.search(note)
        if not m_t:
            continue
        wps_total = money(m_t.group(1))
        if r["sell"] != wps_total:
            bad_a += 1
            diff = r["sell"] - wps_total
            print(
                f"  {r['order_no']:<8} {r['order_type']} {r['trade_date']} "
                f"SELL {r['sell']:>10,.2f} vs 备注成交 {wps_total:>10,.2f}  差 {diff:>9,.2f}"
            )
        if m_p:
            wps_profit = money(m_p.group(1))
            calc = r["sell"] - r["buy"] - r["cost"]
            if calc != wps_profit:
                print(
                    f"     ↳ {r['order_no']} 利润 {calc:>9,.2f} vs 备注 {wps_profit:>9,.2f}"
                    f"  差 {calc - wps_profit:>8,.2f}"
                )
    print(f"  合计不符 {bad_a} 单")

    # ---------- B. 事件 vs 派生流水 ----------
    print("\n=== B. 事件金额 与 派生流水 不符 ===")
    mism = s.execute(
        text(
            """
            select e.event_no, o.order_no, e.amount,
                   coalesce(sum(cf.amount), 0) cf_sum, count(cf.id) n
            from order_events e
            join orders o on o.id = e.order_id
            left join cashflow cf on cf.order_event_id = e.id
            group by e.id, e.event_no, o.order_no, e.amount
            having coalesce(sum(cf.amount), 0) <> e.amount
            order by o.order_no
            """
        )
    ).all()
    for m in mism:
        print(f"  {m[1]:<8} {m[0]:<22} 事件 {m[2]:>10,.2f} vs 流水 {m[3]:>10,.2f}（{m[4]} 条）")
    print(f"  合计 {len(mism)} 条")

    # ---------- C. 状态一致性 ----------
    print("\n=== C. 订单/库存 状态不一致 ===")
    st = s.execute(
        text(
            """
            select o.order_no, o.order_type, o.status ostatus,
                   a.stock_no, a.status astatus, a.inventory_status, a.cost_amount
            from orders o left join stocks a on a.id = o.account_id
            where o.account_id is not null
              and not (
                (o.status = 'COMPLETED' and a.status = 'SOLD')
                or (o.status = 'PENDING' and a.status = 'WAITING')
                or (o.status = 'CANCELLED' and a.status = 'VOID')
              )
            order by o.order_no
            """
        )
    ).all()
    for m in st:
        print(
            f"  {m[0]:<8} 订单 {m[2]:<10} 库存 {m[3]} {m[4]}/{m[5]} 成本 {m[6]}"
        )
    print(f"  合计 {len(st)} 条")

    # ---------- C2. 有 SELL 但库存未售 ----------
    print("\n=== C2. 有卖出事件但库存未置 SOLD ===")
    c2 = [r for r in rows if r["sell"] > 0 and r["status"] != "COMPLETED"]
    for r in c2:
        print(f"  {r['order_no']:<8} 订单 {r['status']:<10} SELL {r['sell']:,.2f}")

    # ---------- C3. COMPLETED 但无 SELL ----------
    print("\n=== C3. 订单已完成但无 SELL 事件 ===")
    c3 = [r for r in rows if r["sell"] == 0 and r["status"] == "COMPLETED"]
    for r in c3:
        print(f"  {r['order_no']:<8} {r['order_type']} {r['trade_date']} BUY {r['buy']:,.2f}")
    if not c3:
        print("  无")

    # ---------- D. 账号重复 ----------
    print("\n=== D. 同一游戏账号多单（需人工确认是否复购） ===")
    dup = s.execute(
        text(
            """
            select a.game_account, count(distinct o.id) n,
                   string_agg(o.order_no, ',' order by o.order_no) orders
            from stocks a join orders o on o.account_id = a.id
            where a.game_account is not null and a.game_account <> ''
            group by a.game_account having count(distinct o.id) > 1
            order by 2 desc limit 15
            """
        )
    ).all()
    for m in dup:
        print(f"  {m[0]:<16} {m[1]} 单: {m[2]}")
    if not dup:
        print("  无")
    print(f"  重复账号 {len(dup)} 个")

    # ---------- E. 事件日期越界 ----------
    print("\n=== E. 事件日期早于订单交易日 / 晚于今天 ===")
    lb = s.execute(
        text(
            """
            select o.order_no, o.trade_date, e.event_type, e.occurred_on
            from order_events e join orders o on o.id = e.order_id
            where e.occurred_on < o.trade_date - interval '1 day'
               or e.occurred_on > current_date
            order by o.order_no
            """
        )
    ).all()
    for m in lb:
        print(f"  {m[0]:<8} 交易日 {m[1]} 事件 {m[2]:<5} {m[3]}")
    print(f"  合计 {len(lb)} 条")

    # ---------- F. 在库未售 ----------
    print("\n=== F. 在库未售（只有 BUY） ===")
    hold = [r for r in rows if r["sell"] == 0]
    tot = sum((r["buy"] for r in hold), Decimal(0))
    for r in hold:
        print(f"  {r['order_no']:<8} {r['order_type']} {r['trade_date']} 本金 {r['buy']:>10,.2f}")
    print(f"  合计 {len(hold)} 单 / 占用 {tot:,.2f}")


if __name__ == "__main__":
    main()
