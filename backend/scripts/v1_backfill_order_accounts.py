"""历史订单库存账号回填（2026-10-28 口径：库存订单 = 全部订单）。

补齐 orders.account_id 为空但快照里有游戏账号的订单：
- 任意状态的订单都建/挂库存账号（取消单 → 账号状态 VOID）；
- 同一 game_account 只建一个账号实体（后续订单挂靠同一账号，与「重开」语义一致）；
- 已在台账中的 game_account 直接挂靠现有账号，不重建；
- 状态推导：CANCELLED→VOID；有已入账 SELL→SOLD；DFQ 合约未结→INSTALLMENT；其余→IN_STOCK；
- cost_amount = 该订单已入账 BUY+COST 之和；buy_date = 最早 BUY 日；
- 无快照/快照无游戏账号的订单（18 笔）无法回填，仅打印清单。

用法：backend/.venv/bin/python3 scripts/v1_backfill_order_accounts.py [--dry-run]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.core.audit import AuditAction, record_audit  # noqa: E402
from app.core.database import get_session_factory  # noqa: E402
from app.domain.trade import Account, Order, OrderEvent  # noqa: E402
from app.orders.service import _create_inline_inventory_account  # noqa: E402
from app.stocks import service as stocks_service  # noqa: E402

ACTOR = "system-backfill"
_INSTALLMENT_OPEN = {"PENDING", "ACTIVE", "OVERDUE"}


def _events(session, order_id: int) -> list[OrderEvent]:
    return session.scalars(
        select(OrderEvent).where(
            OrderEvent.order_id == order_id, OrderEvent.is_posted.is_(True)
        )
    ).all()


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


def _cost_and_buy_date(events: list[OrderEvent]) -> tuple[object, object]:
    from decimal import Decimal

    buys = [e for e in events if e.event_type in {"BUY", "COST"}]
    cost = sum((e.amount for e in buys), Decimal("0.00"))
    buy_date = min((e.occurred_on for e in buys if e.event_type == "BUY"), default=None)
    return cost, buy_date


def _norm_bool(value: object) -> bool | None:
    """老快照 has_secondary 存「有/无」文本，归一为布尔。"""
    if isinstance(value, bool):
        return value
    if value == "有":
        return True
    if value == "无":
        return False
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    session = get_session_factory()()
    existing: dict[str, int] = {}
    for acc in session.scalars(select(Account).where(Account.game_account.is_not(None))):
        existing[acc.game_account.strip()] = acc.id

    orders = session.scalars(
        select(Order)
        .where(Order.account_id.is_(None))
        .order_by(Order.trade_date, Order.id)
    ).all()

    created = linked = skipped = 0
    unfillable: list[tuple[int, str, str]] = []
    seen: dict[str, int] = dict(existing)

    for order in orders:
        snapshot = order.account_snapshot if isinstance(order.account_snapshot, dict) else {}
        raw_ga = snapshot.get("game_account")
        ga = raw_ga.strip() if isinstance(raw_ga, str) else ""
        if not ga:
            unfillable.append((order.id, order.order_no, "快照无游戏账号"))
            skipped += 1
            continue

        events = _events(session, order.id)
        if args.dry_run:
            action = "LINK" if ga in seen else "CREATE"
            print(f"[dry-run] {order.order_no} {order.order_type}/{order.status} -> {action} {ga}")
            continue

        if ga in seen:
            account_id = seen[ga]
            linked += 1
        else:
            account = _create_inline_inventory_account(
                session,
                order_type=order.order_type,
                game_account=ga,
                actor=ACTOR,
                game_type=snapshot.get("game_type"),
                game_password=snapshot.get("game_password"),
                channel_region=snapshot.get("channel_region"),
                bound_phone=snapshot.get("bound_phone"),
                has_secondary=_norm_bool(snapshot.get("has_secondary")),
                account_note=snapshot.get("note"),
                platform=snapshot.get("platform"),
            )
            status = _derive_status(session, order, events)
            cost, buy_date = _cost_and_buy_date(events)
            before = {"status": account.status, "cost_amount": account.cost_amount}
            account.status = status
            account.cost_amount = cost
            account.buy_date = buy_date
            record_audit(
                session,
                action=AuditAction.ACCOUNT_UPDATE,
                entity_type="account",
                entity_id=str(account.id),
                actor=ACTOR,
                before=before,
                after={"status": status, "cost_amount": str(cost), "buy_date": str(buy_date) if buy_date else None,
                       "reason": f"backfill from order {order.order_no}"},
            )
            account_id = account.id
            seen[ga] = account.id
            created += 1

        order.account_id = account_id
        session.add(order)

    if args.dry_run:
        session.rollback()
        print(f"dry-run: 待建 {len([o for o in orders if _ga(o)])}，略过 {skipped}")
        return 0

    session.commit()
    print(f"完成：新建账号 {created}，挂靠已有/同号 {linked}，无法回填 {skipped}")
    for oid, ono, reason in unfillable:
        print(f"  [未回填] {ono} (id={oid}): {reason}")
    return 0


def _ga(order: Order) -> str:
    snapshot = order.account_snapshot if isinstance(order.account_snapshot, dict) else {}
    raw = snapshot.get("game_account")
    return raw.strip() if isinstance(raw, str) else ""


if __name__ == "__main__":
    raise SystemExit(main())
