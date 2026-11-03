"""更正 ZC00001：客户打赏 188 元方向录反（原记支出，实为收入）。

用户 2026-11-01 裁决：打赏是收入。

改动项：
  原  ZC00001  OUT 188.00  BUSINESS_OUT  OPERATING_EXPENSE  category=TIP
  新  SR00049  IN  188.00  BUSINESS_IN   REBATE_INCOME      category=TIP
  pool_id=2 利润池、occurred_on=2026-10-09 保持不变。

做法：直接更正单条（该笔为导入期手工补录、非业务事件派生，冲销会凭空多两笔流水），
同时写审计记录 CASHFLOW_UPDATE，保留原编号于审计原因中。

默认 dry-run，--apply 才提交。
"""
from __future__ import annotations

import json
import sys
from datetime import date
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import select, text  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
import app.domain.trade  # noqa: E402,F401  # 聚合注册全部交易模型，否则 FK 解析失败
from app.domain.trade_models.cashflow import Cashflow  # noqa: E402
from app.finance.attributes import validate_fund_accounting_attribute  # noqa: E402

BACKUP = Path(__file__).with_name("bak_tip_zc00001_20261101.json")
ACTOR = "wps-import"
TARGET = "ZC00001"


def main() -> None:
    apply = "--apply" in sys.argv
    s = get_session_factory()()
    flow = s.scalar(select(Cashflow).where(Cashflow.flow_no == TARGET))
    if flow is None:
        raise SystemExit(f"找不到流水 {TARGET}")

    before = {
        "flow_no": flow.flow_no,
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
    print("原记录:", json.dumps(before, ensure_ascii=False))

    # 下一个可用的收入流水号
    max_sr = s.execute(
        text("select max(flow_no) from cashflow where flow_no like 'SR%'")
    ).scalar() or "SR00000"
    new_no = f"SR{int(max_sr[2:]) + 1:05d}"

    validate_fund_accounting_attribute("BUSINESS", "REBATE_INCOME")

    print("\n计划改为:")
    print(f"  flow_no {TARGET} → {new_no}（收入号段）")
    print("  direction OUT → IN")
    print("  nature BUSINESS_OUT → BUSINESS_IN")
    print("  accounting_attribute OPERATING_EXPENSE → REBATE_INCOME")
    print("  category TIP（不变）")
    print("  amount 188.00（不变） pool 2（利润池） 日期 2026-10-09（不变）")

    if not apply:
        print("\n[dry-run] 未提交。加 --apply 执行。")
        return

    BACKUP.write_text(json.dumps(before, ensure_ascii=False, indent=1), encoding="utf-8")

    flow.flow_no = new_no
    flow.direction = "IN"
    flow.nature = "BUSINESS_IN"
    flow.fund_nature = "BUSINESS"
    flow.accounting_attribute = "REBATE_INCOME"
    flow.note = "客户打赏（WPS 10-09 打赏，更正为收入；原编号 ZC00001 方向录反）"
    flow.updated_by = ACTOR

    # 审计：保留原编号与改动项
    from app.core.audit import record_audit  # noqa: PLC0415
    from app.domain.enums import AuditAction  # noqa: PLC0415

    record_audit(
        s,
        action=AuditAction.CASHFLOW_CREATE,
        entity_type="cashflow",
        entity_id=new_no,
        actor=ACTOR,
        before={"flow_no": TARGET, "direction": before["direction"],
                "nature": before["nature"],
                "accounting_attribute": before["accounting_attribute"],
                "amount": before["amount"]},
        after={
            "from": before,
            "to": {"flow_no": new_no, "direction": "IN", "nature": "BUSINESS_IN",
                   "accounting_attribute": "REBATE_INCOME", "amount": "188.00"},
        },
        reason="客户打赏方向录反（原记支出），按裁决更正为收入",
    )
    s.commit()
    print(f"\n已更正：{TARGET} → {new_no} IN 188.00")

    # 校验
    print("池2 净额:", s.execute(text(
        "select sum(case when direction='IN' then amount else -amount end) from cashflow where pool_id=2"
    )).scalar())
    print("全库净额:", s.execute(text(
        "select sum(case when direction='IN' then amount else -amount end) from cashflow"
    )).scalar())
    print("流水笔数:", s.execute(text("select count(*) from cashflow")).scalar())
    s.close()


if __name__ == "__main__":
    main()
