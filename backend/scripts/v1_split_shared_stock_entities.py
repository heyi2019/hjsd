"""共享库存实体拆分（2026-10-28 复购口径：每次收购独立实体）。

同一 stocks 实体被 ≥2 个「有已入账 BUY 的订单」共享时（回填挂靠或旧
重开语义遗留），拆分为独立实体：
- 最早 BUY 的订单保留原实体，实体 cost/buy_date 重算为仅该订单的事件；
- 其余订单各从快照新建实体（状态推导同回填脚本），cost/buy_date 取各自事件；
- 无 BUY 的共享订单（售出单/寄售单）不属于收购，不参与拆分。

用法：backend/.venv/bin/python3 scripts/v1_split_shared_stock_entities.py [--dry-run]
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.core.audit import AuditAction, record_audit  # noqa: E402
from app.core.database import get_session_factory  # noqa: E402
from app.domain.trade import Account, Order, OrderEvent  # noqa: E402
from app.orders.service import _create_inline_inventory_account  # noqa: E402

ACTOR = "system-split"
_INSTALLMENT_OPEN = {"PENDING", "ACTIVE", "OVERDUE"}


def _norm_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if value == "有":
        return True
    if value == "无":
        return False
    return None


def _posted_events(session, order_id: int) -> list[OrderEvent]:
    return session.scalars(
        select(OrderEvent).where(
            OrderEvent.order_id == order_id, OrderEvent.is_posted.is_(True)
        )
    ).all()


def _cost_and_buy_date(events: list[OrderEvent]) -> tuple[Decimal, object]:
    buys = [e for e in events if e.event_type in {"BUY", "COST"}]
    cost = sum((e.amount for e in buys), Decimal("0.00"))
    buy_date = min((e.occurred_on for e in buys if e.event_type == "BUY"), default=None)
    return cost, buy_date


def _derive_status(session, order: Order, events: list[OrderEvent]) -> str:
    if order.status == "CANCELLED":
        return "VOID"
    if any(e.event_type == "SELL" for e in events):
        return "SOLD"
    if order.order_type == "DFQ":
        from app.domain.trade import Installment

        contract = session.scalar(
            select(Installment).where(Installment.order_id == order.id)
        )
        if contract is not None and contract.status in _INSTALLMENT_OPEN:
            return "INSTALLMENT"
    return "IN_STOCK"


def _snapshot_ga(order: Order) -> str:
    snap = order.account_snapshot if isinstance(order.account_snapshot, dict) else {}
    raw = snap.get("game_account")
    return raw.strip() if isinstance(raw, str) else ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    session = get_session_factory()()
    total_split = 0
    while True:
        # 找共享实体：≥2 个不同订单有已入账 BUY
        buy_orders_by_account: dict[int, list[Order]] = defaultdict(list)
        for order in session.scalars(select(Order)).all():
            events = _posted_events(session, order.id)
            if order.account_id is not None and any(
                e.event_type == "BUY" for e in events
            ):
                buy_orders_by_account[order.account_id].append(order)

        shared = {
            acc_id: sorted(
                orders,
                key=lambda o: (
                    min(
                        (e.occurred_on for e in _posted_events(session, o.id) if e.event_type == "BUY"),
                        default=o.trade_date,
                    ),
                    o.id,
                ),
            )
            for acc_id, orders in buy_orders_by_account.items()
            if len(orders) > 1
        }
        if not shared:
            break

        for acc_id, orders in shared.items():
            keeper, movers = orders[0], orders[1:]
            account = session.get(Account, acc_id)
            # 保留实体：成本/买入日重算为仅 keeper 的事件
            k_cost, k_buy = _cost_and_buy_date(_posted_events(session, keeper.id))
            print(
                f"[拆分] {account.stock_no}({account.game_account}) 保留 {keeper.order_no}，"
                f"拆出 {len(movers)} 单: {','.join(o.order_no for o in movers)}"
            )
            if args.dry_run:
                continue
            before = {"cost_amount": str(account.cost_amount), "buy_date": str(account.buy_date)}
            account.cost_amount = k_cost
            account.buy_date = k_buy
            record_audit(
                session,
                action=AuditAction.ACCOUNT_UPDATE,
                entity_type="account",
                entity_id=str(account.id),
                actor=ACTOR,
                before=before,
                after={"cost_amount": str(k_cost), "buy_date": str(k_buy) if k_buy else None,
                       "reason": f"split shared entity, kept {keeper.order_no}"},
            )
            for order in movers:
                ga = _snapshot_ga(order) or account.game_account
                events = _posted_events(session, order.id)
                new_account = _create_inline_inventory_account(
                    session,
                    order_type=order.order_type,
                    game_account=ga,
                    actor=ACTOR,
                    game_type=(order.account_snapshot or {}).get("game_type"),
                    game_password=(order.account_snapshot or {}).get("game_password"),
                    channel_region=(order.account_snapshot or {}).get("channel_region"),
                    bound_phone=(order.account_snapshot or {}).get("bound_phone"),
                    has_secondary=_norm_bool((order.account_snapshot or {}).get("has_secondary")),
                    account_note=(order.account_snapshot or {}).get("note"),
                    platform=(order.account_snapshot or {}).get("platform"),
                )
                status = _derive_status(session, order, events)
                cost, buy_date = _cost_and_buy_date(events)
                before2 = {"status": new_account.status, "cost_amount": str(new_account.cost_amount)}
                new_account.status = status
                new_account.cost_amount = cost
                new_account.buy_date = buy_date
                record_audit(
                    session,
                    action=AuditAction.ACCOUNT_UPDATE,
                    entity_type="account",
                    entity_id=str(new_account.id),
                    actor=ACTOR,
                    before=before2,
                    after={"status": status, "cost_amount": str(cost),
                           "buy_date": str(buy_date) if buy_date else None,
                           "reason": f"split from {account.stock_no}, owner {order.order_no}"},
                )
                order.account_id = new_account.id
                session.add(order)
            total_split += len(movers)
        if args.dry_run:
            break
        session.commit()

    if args.dry_run:
        session.rollback()
        print(f"dry-run 完成")
        return 0
    session.commit()
    print(f"完成：共拆出 {total_split} 个独立实体")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
