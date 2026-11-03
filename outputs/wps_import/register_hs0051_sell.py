"""HS0051 补登售出：总额法（成交 888 = 本金 472 + 利润 138.40 + 同行分成 277.60）。

口径（2026-11-02 用户裁决）：
  - 客户实付 888 全额进账，其中 277.60 是给同行的分成，属我方资金流出；
  - 系统内按两个事件登记，挂在 HS0051 名下（订单台账的资金收支）：
      1) COST  277.60  OUT  出利润池（同行分成，记 note 说明）
      2) SELL  888.00  IN   拆 472.00 回投资池 + 416.00 进利润池
  - 结果：订单利润 = 888 - 472 - 277.60 = 138.40；投资池净 0；利润池净 +138.40
  - COST 会把 277.60 累加进库存账号成本，执行后校正回 472.00（号价），并写审计。

用法：
  python register_hs0051_sell.py            # dry-run
  python register_hs0051_sell.py --apply    # 执行
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
sys.path.insert(0, str(BACKEND))

from sqlalchemy import select, text  # noqa: E402

from app.core.audit import record_audit  # noqa: E402
from app.core.database import get_session_factory  # noqa: E402
from app.core.security import CurrentUser  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain.enums import AuditAction, EventType  # noqa: E402
from app.domain.trade import Account, Order, OrderEvent  # noqa: E402
from app.orders import service as orders_service  # noqa: E402

ORDER_NO = "HS0051"
OCCURRED_ON = date(2026, 10, 3)
P_INVEST, P_PROFIT = 1, 2
ACTOR = "wps-import"

GROSS = Decimal("888.00")
PRINCIPAL = Decimal("472.00")
PROFIT = Decimal("138.40")
SHARE = GROSS - PRINCIPAL - PROFIT  # 277.60


def pool_balances(session) -> dict[str, Decimal]:
    rows = session.execute(
        text(
            "select p.code, coalesce(sum(case when c.direction='IN' then c.amount else -c.amount end),0) "
            "from pools p left join cashflow c on c.pool_id=p.id group by p.code order by p.code"
        )
    ).all()
    return {code: Decimal(str(total)) for code, total in rows}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    session = get_session_factory(get_settings().alembic_url)()
    admin = CurrentUser.build(id=1, username="admin", roles=("ADMIN",), owner_scope="ALL")

    order = session.scalar(select(Order).where(Order.order_no == ORDER_NO))
    if order is None:
        raise SystemExit(f"{ORDER_NO} 不存在")
    account = session.get(Account, order.account_id) if order.account_id else None
    sell_exists = session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == EventType.SELL.value,
            OrderEvent.is_posted.is_(True),
        )
    )
    cost_exists = session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == EventType.COST.value,
            OrderEvent.is_posted.is_(True),
        )
    )

    before = pool_balances(session)
    print("=" * 70)
    print(f"订单 {order.order_no}  id={order.id}  status={order.status}")
    print(f"库存 {(account.stock_no if account else '-')}  "
          f"{(account.game_account if account else '-')}  "
          f"status={account.status if account else '-'}  cost={account.cost_amount if account else '-'}")
    print(f"现有事件：COST={'有' if cost_exists else '无'}  SELL={'有' if sell_exists else '无'}")
    print(f"执行前池：{before}")
    print("-" * 70)
    print(f"计划 COST {SHARE:,.2f} OUT 池2(利润)  ← 同行分成")
    print(f"计划 SELL {GROSS:,.2f} IN  池1 {PRINCIPAL:,.2f} + 池2 {GROSS - PRINCIPAL:,.2f}（本金回投资池·其余进利润池）")
    print(f"预期：订单利润 138.40；池1 净 0；池2 净 +{PROFIT:,.2f}")
    print("=" * 70)

    if not args.apply:
        print("dry-run，未写库。加 --apply 执行。")
        return

    try:
        if cost_exists:
            print("COST 已存在，跳过。")
        else:
            event, flow = orders_service.post_event(
                session,
                order.id,
                event_type="COST",
                amount=SHARE,
                occurred_on=OCCURRED_ON,
                actor=ACTOR,
                pool_id=P_PROFIT,
                portion="PROFIT",
                note="同行分成 277.60（成交 888 - 本金 472 - 利润 138.40，代收转付）",
                user=admin,
            )
            print(f"COST 已登记：{event.event_no} / 流水 {flow.flow_no if flow else '-'}")

        if sell_exists:
            print("SELL 已存在，跳过。")
        else:
            event, flow = orders_service.post_event(
                session,
                order.id,
                event_type="SELL",
                amount=PRINCIPAL,
                occurred_on=OCCURRED_ON,
                actor=ACTOR,
                pool_id=P_INVEST,
                pool_id2=P_PROFIT,
                amount2=GROSS - PRINCIPAL,
                portion="PROFIT",
                note=f"WPS导入 回收 成交{GROSS:,.2f} 利润{PROFIT:,.2f} | 同行分成{SHARE:,.2f} 已单独记支出",
                user=admin,
            )
            print(f"SELL 已登记：{event.event_no} 合计 {event.amount} / 主流水 {flow.flow_no if flow else '-'}")

        # COST 会把分成计入账号成本，这里校正回号价本金并留审计。
        if account is not None and Decimal(str(account.cost_amount)) != PRINCIPAL:
            old_cost = Decimal(str(account.cost_amount))
            account.cost_amount = PRINCIPAL
            record_audit(
                session,
                action=AuditAction.ACCOUNT_UPDATE,
                entity_type="stock",
                entity_id=account.stock_no,
                actor=ACTOR,
                before={"cost_amount": str(old_cost)},
                after={"cost_amount": str(PRINCIPAL), "reason": "277.60 系同行分成，不计入账号成本"},
            )
            print(f"库存成本校正：{old_cost} -> {PRINCIPAL}")

        session.commit()
    except Exception:
        session.rollback()
        raise

    after = pool_balances(session)
    session.refresh(order)
    session.refresh(account) if account is not None else None
    print("-" * 70)
    print(f"执行后池：{after}")
    print(f"池变化：池1 {after['HJ_INVEST'] - before['HJ_INVEST']:+,.2f}  池2 {after['HJ_PROFIT'] - before['HJ_PROFIT']:+,.2f}")
    print(f"订单状态：{order.status}  库存状态：{account.status if account else '-'}  成本：{account.cost_amount if account else '-'}")

    amounts = orders_service.order_amounts(session, order.id) if hasattr(orders_service, "order_amounts") else None
    if amounts:
        print(f"订单口径：{amounts}")


if __name__ == "__main__":
    main()
