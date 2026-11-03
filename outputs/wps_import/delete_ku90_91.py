"""删除 HS0055 / HS0056（KU_00090 / KU_00091）两笔未付款在库补录单。

用户裁决：这两个号不纳入系统，整单删除（订单 + 库存 + BUY 事件 + PENDING 流水）。

保护措施：
- 默认 dry-run，须显式 --apply
- 删除前校验：备注含"WPS账号表补录"、仅有 1 条 BUY 事件、1 条 PENDING 流水、无 SELL/COST
- 删除前行快照落 bak_delete_ku90_91_*.json
- 逐张写审计（ACTION=ORDER_DELETE / ACCOUNT_DELETE，带 before 与 reason）
- 编号序列不回退（HS0055/0056、KU_00090/91 视为已消耗，不复用）
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from sqlalchemy import text  # noqa: E402

from app.core.audit import record_audit  # noqa: E402
from app.core.database import get_session_factory  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent
TARGETS = ("HS0055", "HS0056")
ACTOR = "wps-import"
REASON = "用户裁决：WPS账号表两笔未付款在库号不纳入系统，整单删除（含库存与待审核流水）"


def _jsonable(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        if isinstance(v, Decimal):
            out[k] = str(v)
        elif hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        elif isinstance(v, (bytes, bytearray)):
            out[k] = v.decode("utf-8", "ignore")
        else:
            out[k] = v
    return out


def _rows(session, sql: str, params: dict) -> list[dict]:
    return [_jsonable(dict(r._mapping)) for r in session.execute(text(sql), params)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写库（默认 dry-run）")
    args = ap.parse_args()

    factory = get_session_factory(get_settings().alembic_url)
    session = factory()
    try:
        orders = _rows(
            session,
            "select * from orders where order_no in ('HS0055','HS0056') order by order_no",
            {},
        )
        if not orders:
            print("两张单都不存在，无需删除。")
            return
        if len(orders) != 2:
            raise SystemExit(f"命中订单 {len(orders)} 张，应为 2 张，终止。")

        snapshot: dict[str, list[dict] | dict] = {"orders": [], "stocks": [], "events": [], "cashflows": []}
        problems: list[str] = []

        for o in orders:
            oid = o["id"]
            if "WPS账号表补录" not in (o.get("note") or ""):
                problems.append(f"{o['order_no']} 备注不含补录标记，拒绝删除")
                continue
            events = _rows(session, "select * from order_events where order_id=:i order by id", {"i": oid})
            flows = _rows(session, "select * from cashflow where order_id=:i order by id", {"i": oid})
            types = [e["event_type"] for e in events]
            if types != ["BUY"]:
                problems.append(f"{o['order_no']} 事件为 {types}，非纯 BUY，拒绝删除")
            if len(flows) != 1 or flows[0]["status"] != "PENDING":
                problems.append(f"{o['order_no']} 流水 {len(flows)} 条/状态非 PENDING，拒绝删除")
            stock = _rows(session, "select * from stocks where id=:i", {"i": o["account_id"]})
            if not stock:
                problems.append(f"{o['order_no']} 找不到库存账号")
            snapshot["orders"].append(o)
            snapshot["events"].extend(events)
            snapshot["cashflows"].extend(flows)
            snapshot["stocks"].extend(stock)

        if problems:
            print("校验未通过，终止：")
            for p in problems:
                print("  -", p)
            raise SystemExit(1)

        print("即将删除：")
        for o, s in zip(snapshot["orders"], snapshot["stocks"]):
            print(
                f"  {o['order_no']} {o['trade_date']} {o['status']}  "
                f"{s['stock_no']} {s['game_account']} 成本 {s['cost_amount']} {s['status']}/{s['inventory_status']}"
            )
            ev = [e for e in snapshot["events"] if e["order_id"] == o["id"]]
            cf = [c for c in snapshot["cashflows"] if c["order_id"] == o["id"]]
            print(f"      事件 {[e['event_no'] + ' ' + e['event_type'] + ' ' + e['amount'] for e in ev]}")
            print(f"      流水 {[c['flow_no'] + ' ' + c['direction'] + ' ' + c['amount'] + ' ' + c['status'] for c in cf]}")

        if not args.apply:
            print("\ndry-run，未写库。加 --apply 执行。")
            return

        bak = OUT_DIR / f"bak_delete_ku90_91_{datetime.now():%Y%m%d-%H%M%S}.json"
        bak.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n快照已存 {bak.name}")

        for o in snapshot["orders"]:
            oid = o["id"]
            sid = o["account_id"]
            stock = next(s for s in snapshot["stocks"] if s["id"] == sid)
            evs = [e for e in snapshot["events"] if e["order_id"] == oid]
            cfs = [c for c in snapshot["cashflows"] if c["order_id"] == oid]

            record_audit(
                session,
                action="ORDER_DELETE",
                entity_type="order",
                entity_id=o["order_no"],
                actor=ACTOR,
                before={
                    "order_no": o["order_no"],
                    "order_type": o["order_type"],
                    "trade_date": o["trade_date"],
                    "status": o["status"],
                    "note": o.get("note"),
                    "stock_no": stock["stock_no"],
                    "game_account": stock["game_account"],
                    "cost_amount": stock["cost_amount"],
                    "events": [{"event_no": e["event_no"], "amount": e["amount"]} for e in evs],
                    "cashflows": [{"flow_no": c["flow_no"], "amount": c["amount"], "status": c["status"]} for c in cfs],
                },
                after=None,
                reason=REASON,
            )
            record_audit(
                session,
                action="ACCOUNT_DELETE",
                entity_type="stock",
                entity_id=stock["stock_no"],
                actor=ACTOR,
                before={
                    "stock_no": stock["stock_no"],
                    "game_account": stock["game_account"],
                    "cost_amount": stock["cost_amount"],
                    "status": stock["status"],
                    "inventory_status": stock["inventory_status"],
                    "order_no": o["order_no"],
                },
                after=None,
                reason=REASON,
            )

            session.execute(text("delete from cashflow where order_id=:i"), {"i": oid})
            session.execute(text("delete from order_events where order_id=:i"), {"i": oid})
            session.execute(text("delete from orders where id=:i"), {"i": oid})
            session.execute(text("delete from stocks where id=:i"), {"i": sid})

        session.commit()
        print("已提交：2 张订单、2 个库存、2 条事件、2 条 PENDING 流水 已删除。")
        print("编号 HS0055/HS0056、KU_00090/KU_00091 视为已消耗，序列不回退、不复用。")
    finally:
        session.close()


if __name__ == "__main__":
    main()
