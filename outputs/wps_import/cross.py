"""交叉验证：用订单表的人员标注，反推账号表昵称对应谁。

匹配键：(日期, 本金≈回收金额, 交易金额≈售卖金额)，容差 1 元。
"""
import json, collections
from decimal import Decimal
from wps_people import ROWS, META

DT = Decimal
orders = json.load(open('wps_orders.json'))

def close(a, b, tol=1):
    return abs(DT(str(a)) - DT(str(b))) <= DT(str(tol))

hits = collections.defaultdict(lambda: collections.Counter())
unmatched_accounts = []
for date, acct, buy, sell, sold, who in ROWS:
    if who == '_':
        continue
    cands = [o for o in orders
             if o['date'] == date
             and close(o['principal'], buy)
             and close(o['amount'], sell)]
    if not cands:
        unmatched_accounts.append((date, acct, buy, sell, META[who][0]))
        continue
    for o in cands:
        for p in (o['recover_by'] or ['(空)']):
            hits[META[who][0]]['回收:' + p] += 1
        for p in (o['sell_by'] or ['(空)']):
            hits[META[who][0]]['售卖:' + p] += 1

print("=== 昵称 → 订单表人员 命中统计 ===")
for nick, c in sorted(hits.items(), key=lambda x: -sum(x[1].values())):
    total = sum(c.values())
    print(f"\n  【{nick}】命中 {total} 人次")
    for k, v in c.most_common():
        print(f"      {k:14s} {v}")

print()
print(f"=== 未匹配到订单的账号 {len(unmatched_accounts)} 条 ===")
for d, a, b, s, n in unmatched_accounts:
    print(f"  {d or '(无日期)':12s} 账号 {a or '(空)':16s} 回收 {DT(b):>10,.2f} 售卖 {DT(s):>10,.2f}  [{n}]")
