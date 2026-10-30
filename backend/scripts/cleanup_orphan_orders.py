"""清理「售出失败」留下的孤儿订单。

背景：库存售出先建订单、后登记事件（InventorySaleModal），事件登记失败时旧版前端不回滚，
会在库里留下 ACTIVE 且无任何事件的空订单，污染订单台账、Dashboard 计数，
并在账号无 BUY 时被库存列表当作「来源订单号」显示。

判定口径：status = ACTIVE 且不存在任何订单事件（不区分 is_posted，有事件就不是孤儿）。

用法（默认只打印不写库，务必先 dry-run）：
    python scripts/cleanup_orphan_orders.py                      # 预览全部类型
    python scripts/cleanup_orphan_orders.py --order-type TH      # 只看提号
    python scripts/cleanup_orphan_orders.py --since 2026-10-01   # 只看某日之后创建的
    python scripts/cleanup_orphan_orders.py --apply              # 真正作废（走后端 cancel_order）

安全约束：
- 不 --apply 时绝不写库；
- 作废走 service.cancel_order，已登记事件的订单会被后端拒绝（"请先冲销"），不会误伤；
- 逐条提交，单条失败不影响其余，失败原因逐条打印。
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.domain.trade import Order, OrderEvent  # noqa: E402
from app.orders import service as orders_service  # noqa: E402

REASON = "售出登记失败的孤儿订单，批量清理作废"


def find_orphans(session, order_types: list[str], since: str | None):
    stmt = select(Order).where(Order.status == "ACTIVE")
    if order_types:
        stmt = stmt.where(Order.order_type.in_(order_types))
    if since:
        stmt = stmt.where(Order.created_at >= datetime.fromisoformat(since))
    rows = []
    for order in session.scalars(stmt.order_by(Order.id)).all():
        has_event = session.scalar(
            select(OrderEvent.id).where(OrderEvent.order_id == order.id)
        )
        if has_event is None:
            rows.append(order)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="清理售出失败残留的无事件孤儿订单")
    parser.add_argument("--order-type", action="append", default=[], help="订单类型，可多次传入，如 TH")
    parser.add_argument("--since", default=None, help="只处理该日期之后创建的订单（YYYY-MM-DD）")
    parser.add_argument("--apply", action="store_true", help="真正作废；不加则只预览")
    args = parser.parse_args()

    session = get_session_factory()()
    orphans = find_orphans(session, [t.upper() for t in args.order_type], args.since)
    if not orphans:
        print("未发现孤儿订单。")
        session.close()
        return 0

    print(f"发现 {len(orphans)} 张无事件的 ACTIVE 订单：")
    for order in orphans:
        print(
            f"  #{order.id} {order.order_no} type={order.order_type} "
            f"account_id={order.account_id} created_at={order.created_at}"
        )

    if not args.apply:
        print("\n[dry-run] 未做任何修改；确认无误后加 --apply 执行作废。")
        session.close()
        return 0

    done = failed = 0
    for order in orphans:
        try:
            orders_service.cancel_order(session, order.id, actor="cleanup", reason=REASON)
            session.commit()
            done += 1
            print(f"  已作废 #{order.id} {order.order_no}")
        except Exception as exc:  # noqa: BLE001 —— 单条失败不影响其余，原因需逐条打印
            session.rollback()
            failed += 1
            print(f"  作废失败 #{order.id} {order.order_no}: {exc}")
    print(f"\n完成：作废 {done} 张，失败 {failed} 张。")
    session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
