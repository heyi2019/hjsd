"""reporting.export：报表统一导出（JSON / CSV）。
"""

from __future__ import annotations

from datetime import date
from typing import Any
from app.core.errors import Validation
from app.core.security import CurrentUser
from sqlalchemy.orm import Session
from .._shared import REPORT_NAMES

from .profit import order_profit_detail
from .monthly_pnl import monthly_pnl_report
from .commission import commission_reconciliation
from .business_pnl import business_pnl_report

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
    sort_desc: bool | None = None,
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
        report = monthly_pnl_report(session, from_date=from_date, to_date=to_date, user=user)
        if sort_desc is not None:
            report["items"].sort(key=lambda row: row["month"], reverse=sort_desc)
        return report
    if name == "commission":
        commission = commission_reconciliation(
            session, from_date=from_date, to_date=to_date, user=user,
            mine=mine, all_people=all_people, user_id=user_id,
        )
        groups = commission["order_groups"]
        if sort_desc is not None:
            groups = sorted(groups, key=lambda row: (str(row["outbound_date"] or row["inventory_date"] or ""), row["order_id"]), reverse=sort_desc)
        return {
            "items": [
                detail
                for order in groups
                for detail in order["orders"]
            ],
            "total": commission["total"],
        }
    if name == "business-pnl":
        return business_pnl_report(session, from_date=from_date, to_date=to_date, user=user)
    report = order_profit_detail(session, from_date=from_date, to_date=to_date, user=user)
    if sort_desc is not None:
        report["items"].sort(key=lambda row: (row["trade_date"], row["order_id"]), reverse=sort_desc)
    return report


# report_csv 已归位 core 层（2026-11-18 P0-A 第三批）：本模块顶部拉起重报表实现
# （间接依赖 orders），lists.export 引用它会形成跨域环。改由 core.report_csv
# 提供，这里保留 re-export 兼容 reporting/router 的既有 import 路径。
from app.core.report_csv import report_csv  # noqa: E402,F401
