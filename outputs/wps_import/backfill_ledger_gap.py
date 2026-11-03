"""补录 WPS「工作室收支」里 ERP 缺失的 14 条 + 修正 1 条方向录反的流水。

来源：`wps_ledger_20261102.csv`（254 条快照）与 ERP 手工流水逐条比对，
差异全部集中在 2026-07-15 与 2026-10-07 之后，属导入时点滞后。

补录口径（沿用既有导入约定）：成本/费用/投资款/退款 → 投资款荷包（池 1）；
返点/打赏/违约金 → 利润荷包（池 2）。本次全部落池 1。

用法：
  python backfill_ledger_gap.py            # dry-run
  python backfill_ledger_gap.py --apply    # 执行
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
sys.path.insert(0, str(BACKEND))

from sqlalchemy import select  # noqa: E402

from app.core.audit import record_audit  # noqa: E402
from app.core.database import get_session_factory  # noqa: E402
from app.core.numbering import allocate_flow_no, current_value, format_next_number  # noqa: E402
from app.core.security import CurrentUser  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain.enums import AuditAction  # noqa: E402
from app.domain.trade import Cashflow  # noqa: E402
from app.finance import cashflows as cashflow_service  # noqa: E402

POOL = 1
ACTOR = "wps-import"
BACKUP = Path(__file__).parent / "bak_ledger_gap_20261102.json"

# 日期, 方向, 类别, 金额, 明细, 核算属性, nature
ITEMS = [
    ("2026-07-23", "IN", "退款", "146.00", "步步高退款（WPS 07-23 支出退回）", "REFUND", "BUSINESS_IN"),
    ("2026-10-07", "OUT", "房租/日用", "334.00", "团建", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-08", "OUT", "房租/日用", "110.00", "团建", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-08", "OUT", "房租/日用", "70.47", "零食", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-09", "OUT", "房租/日用", "378.00", "团建", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-16", "OUT", "员工薪资", "741.49", "凯文9月薪资", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-16", "OUT", "员工薪资", "1642.47", "三三9月薪资", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-16", "OUT", "员工薪资", "7748.08", "小轩9月薪资", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-16", "IN", "员工薪资", "0.06", "多发薪资退回", "REFUND", "BUSINESS_IN"),
    ("2026-10-16", "IN", "投资款", "16890.84", "九月利润转入", "EXTERNAL_FUNDING", "EXTERNAL_IN"),
    ("2026-10-24", "OUT", "房租/日用", "234.86", "团建", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-30", "OUT", "运营", "57.76", "日常维系", "OPERATING_EXPENSE", "BUSINESS_OUT"),
    ("2026-10-31", "OUT", "房租/日用", "300.00", "团建", "OPERATING_EXPENSE", "BUSINESS_OUT"),
]

# 方向录反：WPS 记「支出 房租水电 200」，ERP 却记成「收入 退款 200」
FIX_FLOW_NO = "SR00041"
FIX_TO = {
    "direction": "OUT",
    "nature": "BUSINESS_OUT",
    "category": "房租/日用",
    "accounting_attribute": "OPERATING_EXPENSE",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    session = get_session_factory(get_settings().alembic_url)()
    admin = CurrentUser.build(id=1, username="admin", roles=("ADMIN",), owner_scope="ALL")

    todo, skipped = [], []
    for day, direction, category, amount, note, attr, nature in ITEMS:
        exists = session.scalar(
            select(Cashflow.id).where(
                Cashflow.occurred_on == date.fromisoformat(day),
                Cashflow.direction == direction,
                Cashflow.amount == Decimal(amount),
                Cashflow.note == note,
                Cashflow.pool_id == POOL,
            )
        )
        item = {
            "day": day,
            "direction": direction,
            "category": category,
            "amount": Decimal(amount),
            "note": note,
            "attribute": attr,
            "nature": nature,
        }
        (skipped if exists else todo).append(item)

    pay_in = sum((i["amount"] for i in todo if i["direction"] == "IN"), Decimal("0"))
    pay_out = sum((i["amount"] for i in todo if i["direction"] == "OUT"), Decimal("0"))
    print(f"待补录 {len(todo)} 条（跳过已存在 {len(skipped)} 条）")
    print(f"  收入 {pay_in:,.2f} / 支出 {pay_out:,.2f} / 净 {pay_in - pay_out:,.2f}")
    for i in todo:
        print(f"  {i['day']} {i['direction']:>3} {i['category']:<6} {i['amount']:>10,.2f}  {i['note']}")

    flow = session.scalar(select(Cashflow).where(Cashflow.flow_no == FIX_FLOW_NO))
    if flow is None:
        raise SystemExit(f"{FIX_FLOW_NO} 不存在")

    out_queued = sum(1 for i in todo if i["direction"] == "OUT")
    preview_no = format_next_number(
        sequence_key="CASHFLOW_OUT", prefix="ZC", padding=5,
        current_value=current_value(session, "CASHFLOW_OUT") + out_queued,
    )
    print()
    print(
        f"方向修正 {flow.flow_no}: {flow.direction}/{flow.category}/{flow.accounting_attribute} "
        f"→ {preview_no}/{FIX_TO['direction']}/{FIX_TO['category']}/{FIX_TO['accounting_attribute']}"
        f"（金额 {flow.amount} 不变，明细 {flow.note}）"
    )

    if not args.apply:
        print("\ndry-run，未写库。加 --apply 执行。")
        return

    BACKUP.write_text(
        json.dumps(
            {
                "fix": {
                    "flow_no": flow.flow_no,
                    "direction": flow.direction,
                    "nature": flow.nature,
                    "category": flow.category,
                    "accounting_attribute": flow.accounting_attribute,
                    "amount": str(flow.amount),
                }
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )

    ok, failed = 0, []
    for i in todo:
        try:
            with session.begin_nested():
                cashflow_service.create_cashflow(
                    session,
                    pool_id=POOL,
                    occurred_on=date.fromisoformat(i["day"]),
                    direction=i["direction"],
                    nature=i["nature"],
                    fund_nature="EXTERNAL" if i["nature"] == "EXTERNAL_IN" else "BUSINESS",
                    accounting_attribute=i["attribute"],
                    category=i["category"],
                    amount=i["amount"],
                    note=i["note"],
                    actor=ACTOR,
                    user=admin,
                )
            ok += 1
        except Exception as exc:  # noqa: BLE001 - 逐条隔离
            failed.append((i, str(exc)[:140]))

    if failed:
        session.rollback()
        print(f"\n写入失败 {len(failed)} 条，整批回滚：")
        for i, err in failed:
            print(f"  !! {i['day']} {i['category']} {i['amount']} → {err}")
        return

    before = {
        "flow_no": flow.flow_no,
        "direction": flow.direction,
        "nature": flow.nature,
        "fund_nature": flow.fund_nature,
        "category": flow.category,
        "accounting_attribute": flow.accounting_attribute,
        "amount": str(flow.amount),
    }
    old_no = flow.flow_no
    flow.flow_no = allocate_flow_no(session, "OUT")
    flow.direction = FIX_TO["direction"]
    flow.nature = FIX_TO["nature"]
    flow.fund_nature = "BUSINESS"
    flow.category = FIX_TO["category"]
    flow.accounting_attribute = FIX_TO["accounting_attribute"]
    flow.updated_by = ACTOR
    record_audit(
        session,
        action=AuditAction.CASHFLOW_CREATE,
        entity_type="cashflow",
        entity_id=flow.flow_no,
        actor=ACTOR,
        before=before,
        after={
            "flow_no": flow.flow_no,
            "direction": flow.direction,
            "nature": flow.nature,
            "fund_nature": flow.fund_nature,
            "category": flow.category,
            "accounting_attribute": flow.accounting_attribute,
            "amount": str(flow.amount),
        },
        reason=f"更正 {old_no}：WPS 工作室收支 2026-07-15 记录为「支出 房租/日用 200 房租水电」，"
        f"导入时误记为收入-退款；按源表方向更正并换发支出号段编号",
    )

    session.commit()
    print(f"\n已提交：新增 {ok} 条，{old_no} 更正为 {flow.flow_no}（OUT）。")


if __name__ == "__main__":
    main()
