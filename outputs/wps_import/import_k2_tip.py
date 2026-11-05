"""K2 打赏入账：WPS 11/02 00:19 打赏，交易 700 / 实得 66，备注 w428843。

用户裁决（2026-11-02）：按实得 66 记附加收入（与 10-09 的 188 打赏同口径），
并关联客户 CUS0016（w428843）。流水表无客户外键，客户归属写入摘要。

前置：CASHFLOW_IN 序列停在 48，而 SR00049 已被 188 打赏手工占用，
先抬到 49，避免 allocate 撞唯一号。默认 dry-run。
"""
from __future__ import annotations

import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import select, text

from app.core.database import get_session_factory
from app.core.security import CurrentUser
from app.core.settings import get_settings
from app.domain.trade_models.cashflow import Cashflow
from app.domain.foundation import DocumentSequence
from app.finance import cashflows as cashflow_service

ACTOR = "wps-import"
POOL_ID = 2  # 利润荷包
OCCURRED_ON = date(2026, 11, 2)
AMOUNT = Decimal("66.00")
CUSTOMER_NO = "CUS0016"
CUSTOMER_KEY = "w428843"
NOTE = (
    f"客户打赏（WPS 11-02 打赏 交易700 实得66；客户 {CUSTOMER_NO} {CUSTOMER_KEY}）"
)
BACKUP = Path(__file__).with_name("bak_k2_tip_20261102.json")


def main() -> int:
    apply = "--apply" in sys.argv
    session = get_session_factory(get_settings().alembic_url)()
    try:
        exists = session.scalar(
            select(Cashflow.id).where(
                Cashflow.occurred_on == OCCURRED_ON,
                Cashflow.amount == AMOUNT,
                Cashflow.category == "TIP",
            )
        )
        if exists:
            print(f"已入账，跳过：cashflow id={exists}")
            return 0

        seq_max = session.execute(
            text("select max(cast(substring(flow_no from 3) as integer)) "
                 "from cashflow where flow_no ~ '^SR[0-9]+$'")
        ).scalar() or 0
        seq = session.scalar(
            select(DocumentSequence).where(
                DocumentSequence.sequence_key == "CASHFLOW_IN"
            )
        )
        print(f"SR 现有最大号 {seq_max} / 序列 current={seq.current_value}")
        bump = seq_max > seq.current_value
        print(
            f"序列需抬高至 {seq_max}" if bump else "序列无需调整"
        )
        print(f"待记流水：{OCCURRED_ON} 打赏 IN {AMOUNT} 池{POOL_ID} 属性 ADDITIONAL_INCOME")
        print(f"摘要：{NOTE}")

        if not apply:
            print("\n[dry-run] 未写库；加 --apply 执行")
            return 0

        if bump:
            seq.current_value = seq_max
            session.flush()
            print(f"序列已提升至 {seq.current_value}")

        admin = CurrentUser.build(
            id=1, username="admin", roles=("ADMIN",), owner_scope="ALL", pool_ids=(1, 2)
        )
        flow = cashflow_service.create_cashflow(
            session,
            pool_id=POOL_ID,
            occurred_on=OCCURRED_ON,
            direction="IN",
            nature="BUSINESS_IN",
            fund_nature="BUSINESS",
            accounting_attribute="ADDITIONAL_INCOME",
            category="TIP",
            amount=AMOUNT,
            actor=ACTOR,
            note=NOTE,
            user=admin,
        )
        session.flush()
        snapshot = {
            c.name: getattr(flow, c.name) for c in Cashflow.__table__.columns
        }
        BACKUP.write_text(
            __import__("json").dumps(snapshot, ensure_ascii=False, indent=1, default=str),
            encoding="utf-8",
        )
        session.commit()
        print(f"已创建：{flow.flow_no} {flow.direction} {flow.amount} status={flow.status}")
        print(f"备份：{BACKUP.name}")
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
