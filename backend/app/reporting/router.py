"""经营报表路由：月度损益、分润对账、业务损益、资金日报与订单利润。"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.audit import record_audit
from app.core.security import (
    PERM_REPORT_EXPORT,
    PERM_REPORT_READ,
    CurrentUser,
    require_permissions,
)
from app.lists.export import build_list_csv
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.lists.scopes import report_scope
from app.reporting.export import report_csv, report_for_export
from app.reporting.funds import daily_funds_report
from app.reporting.profit import order_profit_detail
from app.reporting.r2_monthly_pnl import r2_monthly_pnl
from app.reporting.r3_commission import r3_commission_reconciliation
from app.reporting.r5_business_pnl import r5_business_pnl
from app.reporting.data_center import data_center_summary
from app.reporting.schemas import (
    BusinessPnlOut,
    CommissionOut,
    DataCenterOut,
    DailyFundsOut,
    MonthlyPnlOut,
    OrderProfitOut,
)

router = APIRouter(tags=["reporting"])
read_access = require_permissions(PERM_REPORT_READ)
export_access = require_permissions(PERM_REPORT_EXPORT)


@router.get("/reports/monthly-pnl", response_model=MonthlyPnlOut)
def monthly_pnl(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> MonthlyPnlOut:
    """月度经营损益（账号直接支出不进运营费用）。"""
    return r2_monthly_pnl(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/commission", response_model=CommissionOut)
def commission(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    mine: bool = Query(default=False),
    all_people: bool = Query(default=False),
    user_id: int | None = Query(default=None, gt=0),
) -> CommissionOut:
    """分润对账：默认按权限范围汇总；经营中心可显式查看全员并按人员筛选。"""
    return r3_commission_reconciliation(
        db, from_date=from_date, to_date=to_date, user=user, mine=mine, all_people=all_people, user_id=user_id
    )


@router.get("/reports/business-pnl", response_model=BusinessPnlOut)
def business_pnl(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> BusinessPnlOut:
    """业务级损益：主营收入 / 成本 / 毛利均按订单资金明细收支差。"""
    return r5_business_pnl(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/data-center", response_model=DataCenterOut)
def data_center(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> DataCenterOut:
    """数据中心指标：售出成本、在库成本、工作室成本与利润构成。"""
    return data_center_summary(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/daily-funds", response_model=DailyFundsOut)
def daily_funds(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    on: date | None = Query(default=None),
) -> DailyFundsOut:
    """资金日报：与 FIN-01 同日口径一致。"""
    return daily_funds_report(db, on=on, user=user)


@router.get("/reports/order-profit", response_model=OrderProfitOut)
def order_profit(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> OrderProfitOut:
    """订单利润明细：合计与业务级损益对应维度一致。"""
    return order_profit_detail(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/{report_name}/export.csv")
def export_report(
    report_name: str,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = export_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    on: date | None = Query(default=None),
    mine: bool = Query(default=False),
    all_people: bool = Query(default=False),
    user_id: int | None = Query(default=None, gt=0),
) -> Response:
    """导出当前权限范围内的报表；导出动作写入审计日志。
    mine/all_people/user_id 仅作用于分润对账，与 /reports/commission 列表同口径。
    """
    report = report_for_export(
        db,
        report_name,
        from_date=from_date,
        to_date=to_date,
        on=on,
        mine=mine,
        all_people=all_people,
        user_id=user_id,
        user=user,
    )
    # 导出列 = 该报表在「设置 → 列表字段」里的可见列：隐藏的列不导，表头用中文列名。
    # 列拼装（含自定义列注入与值翻译）统一走 lists.export，与主列表导出同一套口径。
    scope = report_scope(report_name)
    if scope is not None:
        total = report.get("total") if isinstance(report.get("total"), dict) else None
        csv_text, export_meta = build_list_csv(
            db, scope.code, report.get("items") or [], total=total
        )
    else:
        csv_text = report_csv(report)
        export_meta = {"column_count": None, "translated_columns": []}
    record_audit(
        db,
        action="REPORT_EXPORT",
        entity_type="report_export",
        entity_id=report_name,
        actor=user.username,
        after={
            "report_name": report_name,
            "item_count": len(report.get("items") or []) if isinstance(report.get("items"), list) else 0,
            "from": from_date.isoformat() if from_date else None,
            "to": to_date.isoformat() if to_date else None,
            "on": on.isoformat() if on else None,
            "mine": mine,
            "all_people": all_people,
            "user_id": user_id,
            "column_count": export_meta["column_count"],
            "translated_columns": export_meta["translated_columns"],
        },
    )
    filename = f"{report_name}-{date.today().isoformat()}.csv"
    return file_response(csv_text, filename, CSV_MEDIA_TYPE)


__all__ = ["router"]
