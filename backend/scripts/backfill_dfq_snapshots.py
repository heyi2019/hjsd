#!/usr/bin/env python3
"""R7 DFQ 账号快照补录导入脚本（自包含，仅用 sqlite3 标准库）。

读取由 `dfq_snapshot_backfill_template.csv` 填好的回执，把每行写回 orders.account_snapshot。

约束（来自 app/orders/service.py:737）：
- 已登记事件(is_posted)的订单，走 update_order 服务会拒绝改 account_snapshot。
- 本脚本默认只写「无 posted 事件」的订单（open 组）。
- 带 --include-locked 才会连「已锁定(COMPLETED+posted)」的 14 笔一起写（直接 SQL，绕过服务守卫，需你显式确认）。

默认 dry-run（只打印将要做什么，不改库）。真正写入需加 --apply。
"""
import argparse
import csv
import json
import sqlite3

SNAPSHOT_FIELDS = [
    "game_account",   # 必填
    "game_type",
    "game_password",
    "channel_region",
    "bound_phone",
    "has_secondary",
    "platform",
    "purchase_price",
    "note",
]

BOOL_FIELDS = {"has_secondary"}


def build_snapshot(row: dict):
    snap = {}
    for f in SNAPSHOT_FIELDS:
        v = (row.get(f) or "").strip()
        if not v:
            continue
        if f in BOOL_FIELDS:
            snap[f] = v.lower() in ("1", "true", "yes", "是")
        else:
            snap[f] = v
    if not snap.get("game_account"):
        raise ValueError(f"{row.get('order_no')} 缺少必填字段 game_account")
    return snap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="填好的补录 CSV（utf-8-sig）")
    ap.add_argument("--db", default="data/heijin_erp_v1.db")
    ap.add_argument("--apply", action="store_true", help="真正写入；默认 dry-run")
    ap.add_argument("--include-locked", action="store_true",
                    help="连已锁定(COMPLETED+posted 事件)的订单也写（直接 SQL 绕过守卫）")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    cur = con.cursor()

    rows = []
    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if not (r.get("order_no") or "").strip():
                continue
            rows.append(r)

    open_ok, locked, skipped = [], [], []
    for r in rows:
        order_no = r["order_no"].strip()
        try:
            snap = build_snapshot(r)
        except ValueError as e:
            skipped.append((order_no, str(e)))
            continue
        cur.execute("SELECT id, account_snapshot FROM orders WHERE order_no=?", (order_no,))
        row = cur.fetchone()
        if row is None:
            skipped.append((order_no, "订单不存在"))
            continue
        order_id, _ = row
        posted = cur.execute(
            "SELECT count(*) FROM order_events WHERE order_id=? AND is_posted=1",
            (order_id,),
        ).fetchone()[0]
        entry = (order_no, order_id, snap)
        if posted > 0:
            locked.append(entry)
        else:
            open_ok.append(entry)

    # 分类输出
    print(f"CSV 行数: {len(rows)}")
    print(f"可导入(open, 无 posted 事件): {len(open_ok)} 笔")
    print(f"已锁定(COMPLETED+posted, 需 --include-locked): {len(locked)} 笔 -> "
          + ", ".join(e[0] for e in locked) if locked else "已锁定: 0 笔")
    print(f"跳过(缺 game_account/不存在): {len(skipped)} 笔")
    for o, reason in skipped:
        print(f"  SKIP {o}: {reason}")

    targets = list(open_ok)
    if args.include_locked:
        targets += locked

    if not args.apply:
        print("\n[DRY-RUN] 以下将被写入 account_snapshot（加 --apply 真正执行）：")
        for order_no, order_id, snap in targets:
            print(f"  {order_no}: {json.dumps(snap, ensure_ascii=False)}")
        con.close()
        return

    n = 0
    for order_no, order_id, snap in targets:
        cur.execute(
            "UPDATE orders SET account_snapshot=?, updated_by='backfill-r7' WHERE id=?",
            (json.dumps(snap, ensure_ascii=False), order_id),
        )
        n += 1
    con.commit()
    con.close()
    print(f"\n[APPLIED] 已写入 {n} 笔 account_snapshot。")


if __name__ == "__main__":
    main()
