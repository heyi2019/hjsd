"""HS0029 利润尾差纠正：利润 239.75 → 239.65。

源数据：WPS 订单表第 74 行（2026-09-29，回收/HS）
    本金 1,000.10 + 利润 239.75 = 1,239.85，但同行成交额为 1,239.75，差 0.10。
用户裁决（2026-11-01）：利润按 239.65 纠正，即 SELL = 本金 + 利润 = 1,239.75。

改动 4 处：
    1. order_events  HS0029-EV-SELL-01  1,239.85 → 1,239.75
    2. cashflow      HS0029-CF-SELL-02    239.75 →   239.65（利润池）
    3. orders.note   利润239.75 → 利润239.65
    4. audit_logs    写入前后值留痕

不动：库存 KU_00039 成本 1,000.10、流水 CF-BUY-01 / CF-SELL-01（本金腿）、编号。
幂等：已是目标值则跳过。
"""
from __future__ import annotations

import json
import sys
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

import app.domain.trade  # noqa: E402,F401  聚合注册交易模型，否则 FK 解析失败
from sqlalchemy import text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.domain.trade_models.cashflow import Cashflow  # noqa: E402

ORDER_NO = "HS0029"
SELL_EVENT_NO = "HS0029-EV-SELL-01"
SELL_FLOW_NO = "HS0029-CF-SELL-02"
OLD_EVENT_AMT = D("1239.85")
NEW_EVENT_AMT = D("1239.75")
OLD_FLOW_AMT = D("239.75")
NEW_FLOW_AMT = D("239.65")
OLD_NOTE = "WPS导入 回收 成交1,239.75 利润239.75"
NEW_NOTE = "WPS导入 回收 成交1,239.75 利润239.65"
BACKUP = Path(__file__).with_name("_backup_hs0029.json")
ACTOR = "wps-import"


def main(apply: bool) -> None:
    s = get_session_factory()()
    order = s.execute(
        text("select id, order_no, note from orders where order_no=:n"), {"n": ORDER_NO}
    ).mappings().first()
    if not order:
        raise SystemExit(f"未找到订单 {ORDER_NO}")
    oid = order["id"]

    ev = s.execute(
        text(
            "select id, event_no, amount from order_events"
            " where order_id=:i and event_type='SELL'"
        ),
        {"i": oid},
    ).mappings().first()
    fl = s.execute(
        text("select id, flow_no, amount, pool_id from cashflow where flow_no=:n"),
        {"n": SELL_FLOW_NO},
    ).mappings().first()
    if not ev or not fl:
        raise SystemExit("事件或流水缺失，终止")

    before = {
        "order_id": oid,
        "order_note": order["note"],
        "event": {"id": ev["id"], "no": ev["event_no"], "amount": str(ev["amount"])},
        "flow": {"id": fl["id"], "no": fl["flow_no"], "amount": str(fl["amount"])},
    }
    print("改前：", json.dumps(before, ensure_ascii=False))
    print(f"目标：事件 {OLD_EVENT_AMT} → {NEW_EVENT_AMT}；流水 {OLD_FLOW_AMT} → {NEW_FLOW_AMT}")

    if ev["amount"] == NEW_EVENT_AMT and fl["amount"] == NEW_FLOW_AMT and order["note"] == NEW_NOTE:
        print("已是目标值，跳过（幂等）")
        s.close()
        return

    assert ev["amount"] == OLD_EVENT_AMT, f"事件金额异常 {ev['amount']}"
    assert fl["amount"] == OLD_FLOW_AMT, f"流水金额异常 {fl['amount']}"
    assert fl["pool_id"] == 2, f"流水不在利润池 {fl['pool_id']}"

    if not apply:
        BACKUP.write_text(json.dumps(before, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[dry-run] 存证已写 {BACKUP.name}")
        s.close()
        return

    # 1) 事件
    s.execute(
        text("update order_events set amount=:a where id=:i"),
        {"a": NEW_EVENT_AMT, "i": ev["id"]},
    )
    # 2) 流水（利润腿）
    cf = s.get(Cashflow, fl["id"])
    cf.amount = NEW_FLOW_AMT
    cf.updated_by = ACTOR
    # 3) 订单备注
    s.execute(text("update orders set note=:n where id=:i"), {"n": NEW_NOTE, "i": oid})

    # 4) 审计
    from app.core.audit import record_audit  # noqa: PLC0415
    from app.domain.enums import AuditAction  # noqa: PLC0415

    record_audit(
        s,
        action=AuditAction.CASHFLOW_CREATE,
        entity_type="Cashflow",
        entity_id=SELL_FLOW_NO,
        actor=ACTOR,
        before={
            "order_no": ORDER_NO,
            "sell_event_no": SELL_EVENT_NO,
            "sell_event_amount": str(OLD_EVENT_AMT),
            "profit_flow_no": SELL_FLOW_NO,
            "profit_flow_amount": str(OLD_FLOW_AMT),
            "order_note": OLD_NOTE,
        },
        after={
            "order_no": ORDER_NO,
            "sell_event_no": SELL_EVENT_NO,
            "sell_event_amount": str(NEW_EVENT_AMT),
            "profit_flow_no": SELL_FLOW_NO,
            "profit_flow_amount": str(NEW_FLOW_AMT),
            "order_note": NEW_NOTE,
        },
        reason="HS0029 利润尾差纠正：源表本金1000.10+利润239.75=1239.85 与成交额1239.75 差0.10，按成交额取利润239.65",
    )

    s.commit()
    print("已提交")
    s.close()


if __name__ == "__main__":
    main("--apply" in sys.argv)
