"""reporting.export：报表统一导出（JSON / CSV）。
"""

from __future__ import annotations

from datetime import date
from typing import Any
from app.core.errors import Validation
from app.core.security import CurrentUser
from sqlalchemy.orm import Session
from ._shared import REPORT_NAMES

from .profit import order_profit_detail
from .r2_monthly_pnl import r2_monthly_pnl
from .r3_commission import r3_commission_reconciliation
from .r5_business_pnl import r5_business_pnl

__all__ = ["report_csv", "report_for_export"]

def report_for_export(
    session: Session,
    report_name: str,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    on: date | None = None,
    mine: bool = False,
    all_people: bool = False,
    user_id: int | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """统一执行可导出的报表，所有分支复用既有数据权限和口径。
    mine/all_people/user_id 仅作用于分润对账，使导出与「我的收益/指定员工」页面视图同口径。
    """
    name = report_name.strip().lower()
    if name not in REPORT_NAMES:
        raise Validation(
            "不支持导出的报表",
            details={"report_name": report_name, "allowed": sorted(REPORT_NAMES)},
        )
    if name == "monthly-pnl":
        return r2_monthly_pnl(session, from_date=from_date, to_date=to_date, user=user)
    if name == "commission":
        commission = r3_commission_reconciliation(
            session, from_date=from_date, to_date=to_date, user=user,
            mine=mine, all_people=all_people, user_id=user_id,
        )
        return {
            "items": [
                detail
                for order in commission["order_groups"]
                for detail in order["orders"]
            ],
            "total": commission["total"],
        }
    if name == "business-pnl":
        return r5_business_pnl(session, from_date=from_date, to_date=to_date, user=user)
    return order_profit_detail(session, from_date=from_date, to_date=to_date, user=user)


# report_csv 已归位 core 层（2026-11-18 P0-A 第三批）：本模块顶部拉起重报表实现
# （间接依赖 orders），lists.export 引用它会形成跨域环。改由 core.report_csv
# 提供，这里保留 re-export 兼容 reporting/router 的既有 import 路径。
from app.core.report_csv import report_csv  # noqa: E402,F401
