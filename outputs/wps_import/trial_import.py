"""试建：在库副本上验证 HS/DG 建单 + 事件 + 资金池拆分链路。不触碰生产库。"""
import shutil
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
sys.path.insert(0, str(BACKEND))

from sqlalchemy import text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.core.security import CurrentUser  # noqa: E402
from app.orders import service as orders_service  # noqa: E402
from app.stocks import service as stocks_service  # noqa: E402

SRC = BACKEND / "data/heijin_erp_v1.db"
TMP = Path("/tmp/wps_trial.db")
shutil.copyfile(SRC, TMP)

Session = get_session_factory(f"sqlite+pysqlite:///{TMP}")
db = Session()
admin = CurrentUser.build(id=1, username="admin", roles=("ADMIN",), owner_scope="ALL")

BUY_POOL = 1   # HJ_INVEST 投资款荷包
PROFIT_POOL = 2  # HJ_PROFIT 利润荷包

print("=" * 60)
print("【A】HS 回收单：占位库存账号 + BUY + SELL 双池")
acct = stocks_service.create_account(
    db, game_account="WPS-TRIAL-001", actor="wps-import",
    game_type="王者荣耀", note="WPS 历史导入占位账号",
)
db.flush()
print("  库存编号:", acct.stock_no, "账号:", acct.game_account)

order = orders_service.create_order(
    db, order_type="HS", trade_date=date(2026, 7, 18), actor="wps-import",
    account_id=acct.id, note="WPS导入 07-18 回收 交易1135.6 本金670",
    user=admin,
)
db.flush()
print("  订单编号:", order.order_no, "状态:", order.status)

orders_service.post_event(
    db, order.id, event_type="BUY", amount=Decimal("670"),
    occurred_on=date(2026, 7, 18), actor="wps-import",
    pool_id=BUY_POOL, portion="PRINCIPAL", user=admin,
)
ev, flows = orders_service.post_event(
    db, order.id, event_type="SELL", amount=Decimal("670"),
    occurred_on=date(2026, 7, 18), actor="wps-import",
    pool_id=BUY_POOL, pool_id2=PROFIT_POOL, amount2=Decimal("465.6"),
    portion="PRINCIPAL", user=admin,
)
db.flush()
print("  SELL 事件编号:", ev.event_no, "金额:", ev.amount)
for f in db.execute(text("select flow_no,pool_id,direction,amount,note from cashflow where order_id=:i"), {"i": order.id}):
    print("   流水:", f)

print()
print("【B】DG 代挂单：无账号 + 单池 SELL")
dg = orders_service.create_order(
    db, order_type="DG", trade_date=date(2026, 7, 14), actor="wps-import",
    note="WPS导入 07-14 代挂 交易13888 佣金429", user=admin,
)
db.flush()
print("  订单编号:", dg.order_no, "状态:", dg.status)
ev2, _ = orders_service.post_event(
    db, dg.id, event_type="SELL", amount=Decimal("13888"),
    occurred_on=date(2026, 7, 14), actor="wps-import",
    pool_id=PROFIT_POOL, portion="PROFIT", user=admin,
)
db.flush()
print("  SELL 事件编号:", ev2.event_no, "金额:", ev2.amount)
for f in db.execute(text("select flow_no,pool_id,direction,amount from cashflow where order_id=:i"), {"i": dg.id}):
    print("   流水:", f)

print()
print("【C】池内余额（有符号和）")
for row in db.execute(text(
    "select p.code, p.name, "
    "coalesce(sum(case when c.direction='IN' then c.amount else -c.amount end),0) "
    "from pools p left join cashflow c on c.pool_id=p.id group by p.id order by p.id"
)):
    print("  ", row)

db.rollback()
print()
print("试建完成（已回滚，库副本保留在 /tmp/wps_trial.db）")
