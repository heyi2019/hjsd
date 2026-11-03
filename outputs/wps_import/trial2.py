"""沙箱试建：验证 SELL 双池拆分对订单利润与流水的影响（SQLite 空库，不碰任何真实数据）。"""
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

TMP = Path("/tmp/wps_trial2.db")
shutil.copyfile(Path("/tmp/schema_check.db"), TMP)

Session = get_session_factory(f"sqlite+pysqlite:///{TMP}")
db = Session()
db.execute(
    text(
        "INSERT INTO users (id, username, display_name, password_hash, role, owner_scope, "
        "pool_ids, team_ids, is_active, must_change_password, created_at, updated_at) "
        "VALUES (1, 'admin', '管理员', 'x', 'ADMIN', 'ALL', '[]', '[]', 1, 0, "
        "datetime('now'), datetime('now'))"
    )
)
db.flush()
admin = CurrentUser.build(id=1, username="admin", roles=("ADMIN",), owner_scope="ALL")

P1, P2 = 1, 2


def show(tag, order_id):
    print(f"  [{tag}] 事件与流水：")
    for r in db.execute(
        text("select event_type,portion,amount,pool_id from order_events where order_id=:i order by id"),
        {"i": order_id},
    ):
        print("    事件:", r)
    for r in db.execute(
        text("select flow_no,pool_id,direction,amount from cashflow where order_id=:i order by id"),
        {"i": order_id},
    ):
        print("    流水:", r)


print("=" * 66)
print("【实验1】HS：BUY(670) + SELL(amount=670, pool2=利润, amount2=465.6)")
acct = stocks_service.create_account(
    db, game_account="TRIAL-A", actor="trial", game_type="王者荣耀", note="试建",
    business_mode="SELF", inventory_type="RECOVERY",
)
db.flush()
o1 = orders_service.create_order(
    db, order_type="HS", trade_date=date(2026, 7, 18), actor="trial", account_id=acct.id, user=admin
)
db.flush()
orders_service.post_event(
    db, o1.id, event_type="BUY", amount=Decimal("670"), occurred_on=date(2026, 7, 18),
    actor="trial", pool_id=P1, portion="PRINCIPAL", user=admin,
)
try:
    orders_service.post_event(
        db, o1.id, event_type="SELL", amount=Decimal("670"), occurred_on=date(2026, 7, 18),
        actor="trial", pool_id=P1, pool_id2=P2, amount2=Decimal("465.6"),
        portion="PROFIT", user=admin,
    )
    db.flush()
    show("实验1", o1.id)
except Exception as exc:
    print("    FAILED:", type(exc).__name__, str(exc)[:200])

print()
print("=" * 66)
print("【实验2】HS：BUY(670) + SELL(amount=1135.6, 单池利润池)")
acct2 = stocks_service.create_account(
    db, game_account="TRIAL-B", actor="trial", note="试建",
    business_mode="SELF", inventory_type="RECOVERY",
)
db.flush()
o2 = orders_service.create_order(
    db, order_type="HS", trade_date=date(2026, 7, 19), actor="trial", account_id=acct2.id, user=admin
)
db.flush()
orders_service.post_event(
    db, o2.id, event_type="BUY", amount=Decimal("670"), occurred_on=date(2026, 7, 19),
    actor="trial", pool_id=P1, portion="PRINCIPAL", user=admin,
)
try:
    orders_service.post_event(
        db, o2.id, event_type="SELL", amount=Decimal("1135.6"), occurred_on=date(2026, 7, 19),
        actor="trial", pool_id=P2, portion="PROFIT", user=admin,
    )
    db.flush()
    show("实验2", o2.id)
except Exception as exc:
    print("    FAILED:", type(exc).__name__, str(exc)[:200])

print()
print("=" * 66)
print("【实验3】DG：SELL(amount=429 佣金, 利润池)")
o3 = orders_service.create_order(
    db, order_type="DG", trade_date=date(2026, 7, 14), actor="trial", user=admin,
    note="WPS 07-14 代挂 成交额 13888 佣金 429",
)
db.flush()
try:
    orders_service.post_event(
        db, o3.id, event_type="SELL", amount=Decimal("429"), occurred_on=date(2026, 7, 14),
        actor="trial", pool_id=P2, portion="PROFIT", user=admin,
    )
    db.flush()
    show("实验3", o3.id)
except Exception as exc:
    print("    FAILED:", type(exc).__name__, str(exc)[:200])

print()
print("=" * 66)
print("【汇总】池余额 / 订单金额")
for r in db.execute(
    text(
        "select p.code, coalesce(sum(case when c.direction='IN' then c.amount else -c.amount end),0) "
        "from pools p left join cashflow c on c.pool_id=p.id group by p.id order by p.id"
    )
):
    print("  池:", r)
for r in db.execute(text("select order_no,order_type,status,account_id from orders order by id")):
    print("  单:", r)
from app.orders import queries  # noqa: E402

for oid in (o1.id, o2.id, o3.id):
    try:
        d = queries.order_amounts(db, oid) if hasattr(queries, "order_amounts") else None
        print("  金额口径", oid, d)
    except Exception as exc:
        print("  金额口径不可用:", str(exc)[:80])

db.rollback()
print("\n完成（已回滚）")
