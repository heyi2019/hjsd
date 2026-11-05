"""导入结果对账：逐单比对 WPS 金额与 ERP 事件金额，定位差异。"""
import json
from decimal import Decimal
from pathlib import Path

import sys

sys.path.insert(0, "/Users/aries/黑金时代/backend")
sys.path.insert(0, str(Path(__file__).parent))
from sqlalchemy import create_engine, text  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from import_wps import resolve_type  # noqa: E402

BASE = Path(__file__).parent
rows = json.loads((BASE / "wps_orders.json").read_text())

e = create_engine(get_settings().alembic_url)
with e.connect() as c:
    orders = c.execute(
        text(
            "select o.id,o.order_no,o.order_type,o.trade_date,o.note,"
            "(select coalesce(sum(amount),0) from order_events x where x.order_id=o.id and x.event_type='BUY') buy_amt,"
            "(select coalesce(sum(amount),0) from order_events x where x.order_id=o.id and x.event_type='SELL') sell_amt "
            "from orders o order by o.trade_date,o.id"
        )
    ).fetchall()

print("库内订单", len(orders))
buy_total = sum(r[5] for r in orders)
sell_total = sum(r[6] for r in orders)
print(f"BUY 合计 {buy_total:,.2f} | SELL 合计 {sell_total:,.2f}")

# WPS 侧：需要建单且本金>0 的单（= 实际应入库）
def is_in_scope(r):
    code = resolve_type(r["order_type_raw"], r["principal"])
    if code is None:
        return False
    if code in ("HS", "TH") and r["principal"] <= 0:
        return False
    return True


scope = [r for r in rows if is_in_scope(r)]
print(
    f"WPS 应入库 {len(scope)} 单 | 本金 {sum(r['principal'] for r in scope):,.2f}"
    f" | 利润 {sum(r['profit'] for r in scope):,.2f}"
)
print(
    f"实际入库 {len(orders)} 单 | BUY {buy_total:,.2f} | 利润(SELL-BUY) {sell_total - buy_total:,.2f}"
)
print()
print("=== 利润偏差构成（WPS利润 - 实际利润）===")
wps_profit = Decimal(str(sum(r["profit"] for r in scope)))
erp_profit = sell_total - buy_total
print("WPS 利润合计", wps_profit, "| ERP 利润合计", erp_profit, "| 差", wps_profit - erp_profit)

print()
print("=== 负利润 / 异常单 ===")
for r in scope:
    if r["profit"] < 0:
        print(f"  {r['date']} {r['order_type_raw']} 成交{r['amount']:,.2f} 本金{r['principal']:,.2f} 利润{r['profit']:,.2f} {r['note']}")

print()
print("=== 成交额与(本金+利润)偏差 > 1 元的单 ===")
n = 0
for r in scope:
    gap = r["amount"] - r["principal"] - r["profit"]
    if abs(gap) > 1:
        n += 1
        print(f"  {r['date']} {r['order_type_raw']} 成交{r['amount']:>9,.2f} 本金{r['principal']:>9,.2f} 利润{r['profit']:>8,.2f} 差{gap:>8,.2f}")
print("  小计", n, "单")
