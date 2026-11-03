"""更正 SR00001 违约金 51.50 的核算属性：自营收入 → 附加收入。

用户 2026-11-01 裁决：违约金是收入，且应与打赏同口径归附加收入（选 A）。

改动项（仅核算属性，其余一律不动）：
  accounting_attribute  SELF_REVENUE → REBATE_INCOME
  不变：flow_no=SR00001  direction=IN  nature=BUSINESS_IN  fund_nature=BUSINESS
        amount=51.50  pool_id=2（利润池）  category=PENALTY  occurred_on=2026-10-14

理由：SELF_REVENUE 全库 92 笔里唯一无关联订单的一笔，挂自营收入会虚增自营营业额；
打赏 188（SR00049）已归 REBATE_INCOME，违约金属同类非卖号收入，口径统一。

资金影响：零。IN 51.50 不变、池2 净额不变、系统总额不变，只动报表分类。

默认 dry-run，--apply 才提交。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import select, text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
import app.domain.trade  # noqa: E402,F401  # 聚合注册全部交易模型
from app.domain.trade_models.cashflow import Cashflow  # noqa: E402
from app.finance.attributes import validate_fund_accounting_attribute  # noqa: E402

BACKUP = Path(__file__).with_name("bak_penalty_sr00001_20261101.json")
ACTOR = "wps-import"
TARGET = "SR00001"
NEW_ATTR = "REBATE_INCOME"


def main() -> None:
    apply = "--apply" in sys.argv
    s = get_session_factory()()

    flow = s.scalar(select(Cashflow).where(Cashflow.flow_no == TARGET))
    if flow is None:
        raise SystemExit(f"找不到流水 {TARGET}")

    before = {
        "flow_no": flow.flow_no,
        "id": flow.id,
        "pool_id": flow.pool_id,
        "occurred_on": flow.occurred_on.isoformat(),
        "direction": flow.direction,
        "nature": flow.nature,
        "fund_nature": flow.fund_nature,
        "accounting_attribute": flow.accounting_attribute,
        "category": flow.category,
        "amount": str(flow.amount),
        "note": flow.note,
    }
    print("原记录:", json.dumps(before, ensure_ascii=False, indent=1))

    if flow.accounting_attribute == NEW_ATTR:
        print(f"\n已是 {NEW_ATTR}，无需改动（幂等）。")
        s.close()
        return

    validate_fund_accounting_attribute(flow.fund_nature, NEW_ATTR)

    print("\n计划改动（仅一项）:")
    print(f"  accounting_attribute  {flow.accounting_attribute} → {NEW_ATTR}")
    print("  其余字段（编号/方向/性质/金额/池/类别/日期）全部不动")

    # 改前分类合计，便于对比
    q = text("""select accounting_attribute, count(*), sum(amount) from cashflow
                where order_id is null and direction='IN'
                group by 1 order by 3 desc""")
    print("\n改前（无订单·收入）分类合计:")
    for r in s.execute(q).all():
        print(f"  {r[0]:<20}{r[1]:>4} 笔  {r[2]:>12}")

    if not apply:
        print("\n[dry-run] 未提交。加 --apply 执行。")
        s.close()
        return

    BACKUP.write_text(json.dumps(before, ensure_ascii=False, indent=1), encoding="utf-8")

    flow.accounting_attribute = NEW_ATTR
    flow.updated_by = ACTOR

    from app.core.audit import record_audit  # noqa: PLC0415
    from app.domain.enums import AuditAction  # noqa: PLC0415

    record_audit(
        s,
        action=AuditAction.CASHFLOW_CREATE,
        entity_type="cashflow",
        entity_id=TARGET,
        actor=ACTOR,
        before={"accounting_attribute": before["accounting_attribute"],
                "category": before["category"], "amount": before["amount"]},
        after={"accounting_attribute": NEW_ATTR,
               "category": before["category"], "amount": before["amount"]},
        reason="违约金 51.50 属非卖号收入，由自营收入改归附加收入，与打赏 188 同口径",
    )
    s.commit()

    print(f"\n已更正：{TARGET} accounting_attribute → {NEW_ATTR}")

    print("\n改后（无订单·收入）分类合计:")
    for r in s.execute(q).all():
        print(f"  {r[0]:<20}{r[1]:>4} 笔  {r[2]:>12}")

    print("\n资金校验（应全部不变）:")
    for r in s.execute(text("""select pool_id, count(*),
        sum(case when direction='IN' then amount else -amount end)
        from cashflow group by 1 order by 1""")).all():
        print("  pool", r)
    print("  total", s.execute(text(
        "select sum(case when direction='IN' then amount else -amount end) from cashflow"
    )).scalar())
    print("  flows", s.execute(text("select count(*) from cashflow")).scalar())
    s.close()


if __name__ == "__main__":
    main()
