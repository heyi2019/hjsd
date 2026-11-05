"""把 HS0051 的同行分成（277.60）从「自营直接成本」改归类为「附加支出」。

背景：该支出先以 COST 事件登记、属性沿用 SELF_DIRECT_COST；0007 迁移新增
ADDITIONAL_EXPENSE 后，需要把成交环节的过手分成从号价成本中分离出来。
金额、方向、资金池、事件全部不动，只改 cashflow.accounting_attribute。

用法：
  python reclassify_hs0051_share.py            # dry-run
  python reclassify_hs0051_share.py --apply    # 执行
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
sys.path.insert(0, str(BACKEND))

from sqlalchemy import select  # noqa: E402

from app.core.audit import record_audit  # noqa: E402
from app.core.database import get_session_factory  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain.enums import AccountingAttribute, AuditAction  # noqa: E402
from app.domain.trade import Cashflow  # noqa: E402

FLOW_NO = "HS0051-CF-COST-01"
TARGET = AccountingAttribute.ADDITIONAL_EXPENSE.value
ACTOR = "wps-import"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    session = get_session_factory(get_settings().alembic_url)()
    flow = session.scalar(select(Cashflow).where(Cashflow.flow_no == FLOW_NO))
    if flow is None:
        raise SystemExit(f"流水 {FLOW_NO} 不存在")

    print(f"{flow.flow_no}  {flow.direction} {flow.amount}  "
          f"category={flow.category}  属性={flow.accounting_attribute}  note={flow.note}")
    if flow.accounting_attribute == TARGET:
        print("已是附加支出，无需改动。")
        return
    if not args.apply:
        print(f"计划：{flow.accounting_attribute} -> {TARGET}（金额/方向/池不变）")
        print("dry-run，未写库。加 --apply 执行。")
        return

    before = flow.accounting_attribute
    flow.accounting_attribute = TARGET
    flow.updated_by = ACTOR
    record_audit(
        session,
        action=AuditAction.CASHFLOW_CREATE,
        entity_type="cashflow",
        entity_id=flow.flow_no,
        actor=ACTOR,
        before={"accounting_attribute": before},
        after={"accounting_attribute": TARGET},
        reason="同行分成属成交环节附加费用，不计入号价直接成本",
    )
    session.commit()
    print(f"已改：{before} -> {TARGET}")


if __name__ == "__main__":
    main()
