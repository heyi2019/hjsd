"""修复导入时被抹平的亏损单：按业主要求把利润落地为 -313。

背景：import_wps.py 原逻辑 `if profit > 0` 才拆双池，亏损单走 else 分支，
SELL 金额被置为本金（利润变 0），导致 HS0042 亏 313 被吃掉、利润池虚高。

本脚本按「订单利润 = SELL - BUY」反推 SELL 金额：
    SELL = BUY + profit = 14710 + (-313) = 14397
流水侧同步把池1 收回金额改为 14397（本金池承担该 313 亏损）。

用法：
    python3 fix_loss_order.py            # dry-run
    python3 fix_loss_order.py --apply    # 执行
"""
from __future__ import annotations

import json
import sys
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import create_engine, text  # noqa: E402

from app.core.settings import get_settings  # noqa: E402

ORDER_NO = "HS0042"
WPS_PROFIT = D("-313.00")      # WPS 订单表原始利润
WPS_GROSS = D("14088.00")      # WPS 订单表原始成交额（三数不自洽，仅留档）
BACKUP = Path(__file__).with_name("bak_HS0042_20261101-2300.json")


def main(apply: bool) -> None:
    eng = create_engine(get_settings().alembic_url)
    with eng.connect() as c:
        buy = c.execute(
            text(
                "select coalesce(sum(e.amount),0) from orders o join order_events e "
                "on e.order_id=o.id where o.order_no=:n and e.event_type='BUY' and e.is_posted"
            ),
            {"n": ORDER_NO},
        ).scalar()
        sell = c.execute(
            text(
                "select coalesce(sum(e.amount),0) from orders o join order_events e "
                "on e.order_id=o.id where o.order_no=:n and e.event_type='SELL' and e.is_posted"
            ),
            {"n": ORDER_NO},
        ).scalar()
        buy, sell = D(str(buy)), D(str(sell))
        target_sell = buy + WPS_PROFIT

        print(f"{ORDER_NO}: BUY={buy} SELL={sell} 当前利润={sell-buy}")
        print(f"目标: SELL={target_sell} 利润={WPS_PROFIT}")
        if sell == target_sell:
            print("已是目标值，无需修改")
            return
        if not BACKUP.exists():
            raise SystemExit(f"缺少备份 {BACKUP}，拒绝执行")

        # 口径提示：WPS 三数不自洽（本金+利润 != 成交额）
        drift = buy + WPS_PROFIT - WPS_GROSS
        if drift != 0:
            print(
                f"注意: WPS 原始行 本金{buy} + 利润{WPS_PROFIT} = {buy + WPS_PROFIT}，"
                f"但其成交额填 {WPS_GROSS}，差 {drift}。按利润 {WPS_PROFIT} 落地。"
            )

    if not apply:
        print("\n[dry-run] 未写库。加 --apply 执行。")
        return

    with eng.begin() as c:
        n_ev = c.execute(
            text(
                "update order_events set amount=:a, updated_by='fix-loss-order' "
                "where order_id=(select id from orders where order_no=:n) and event_type='SELL'"
            ),
            {"a": target_sell, "n": ORDER_NO},
        ).rowcount
        n_cf = c.execute(
            text(
                "update cashflow set amount=:a, updated_by='fix-loss-order' "
                "where flow_no=:f"
            ),
            {"a": target_sell, "f": f"{ORDER_NO}-CF-SELL-01"},
        ).rowcount
        note = (
            f"WPS导入 回收 本金{buy:,.2f} 利润{WPS_PROFIT:,.2f}"
            f"（WPS原成交额记{WPS_GROSS:,.2f}，与本金+利润差{buy + WPS_PROFIT - WPS_GROSS:,.2f}，按利润落地）"
        )
        n_or = c.execute(
            text("update orders set note=:t, updated_by='fix-loss-order' where order_no=:n"),
            {"t": note, "n": ORDER_NO},
        ).rowcount
    print(f"\n已更新：事件 {n_ev} 条、流水 {n_cf} 条、订单 {n_or} 条")


if __name__ == "__main__":
    main("--apply" in sys.argv)
