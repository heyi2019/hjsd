"""reporting.router：R1/R2/R3/R5、资金日报与订单利润（RPT-01）。"""
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
from app.lists.export import build_list_csv, csv_file_response
from app.lists.scopes import report_scope
from app.reporting import service
from app.reporting.schemas import (
    BusinessPnlOut,
    FinanceDimensionOut,
    CommissionOut,
    DailyFundsOut,
    InventoryHealthOut,
    MonthlyPnlOut,
    OrderProfitOut,
)

router = APIRouter(tags=["reporting"])
read_access = require_permissions(PERM_REPORT_READ)
export_access = require_permissions(PERM_REPORT_EXPORT)


@router.get("/reports/inventory-health", response_model=InventoryHealthOut)
def inventory_health(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> InventoryHealthOut:
    """R1 自营库存健康表（提号实体可追踪，但不计入自营资产统计）。"""
    return service.r1_inventory_health(db, user=user)


@router.get("/reports/monthly-pnl", response_model=MonthlyPnlOut)
def monthly_pnl(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> MonthlyPnlOut:
    """R2 月度经营损益（账号 COST 不进运营费用）。"""
    return service.r2_monthly_pnl(db, from_date=from_date, to_date=to_date, user=user)


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
    """R3 提成对账：默认按权限范围汇总；经营中心可显式查看全员并按人员筛选。"""
    return service.r3_commission_reconciliation(
        db, from_date=from_date, to_date=to_date, user=user, mine=mine, all_people=all_people, user_id=user_id
    )


@router.get("/reports/business-pnl", response_model=BusinessPnlOut)
def business_pnl(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> BusinessPnlOut:
    """R5 业务级损益：主营收入 / 成本 / 毛利均按订单资金明细收支差。"""
    return service.r5_business_pnl(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/finance-dimensions", response_model=FinanceDimensionOut)
def finance_dimensions(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> FinanceDimensionOut:
    """按资金池、资金性质、核算属性和现金方向聚合已审核流水。"""
    return service.finance_dimension_report(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/daily-funds", response_model=DailyFundsOut)
def daily_funds(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    on: date | None = Query(default=None),
) -> DailyFundsOut:
    """资金日报：与 FIN-01 同日口径一致。"""
    return service.daily_funds_report(db, on=on, user=user)


@router.get("/reports/order-profit", response_model=OrderProfitOut)
def order_profit(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> OrderProfitOut:
    """订单利润明细：合计与 R5 对应维度一致。"""
    return service.order_profit_detail(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/{report_name}/export.csv")
def export_report(
    report_name: str,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = export_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    on: date | None = Query(default=None),
) -> Response:
    """导出当前权限范围内的报表；导出动作写入审计日志。"""
    report = service.report_for_export(
        db,
        report_name,
        from_date=from_date,
        to_date=to_date,
        on=on,
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
        csv_text = service.report_csv(report)
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
            "column_count": export_meta["column_count"],
            "translated_columns": export_meta["translated_columns"],
        },
    )
    filename = f"{report_name}-{date.today().isoformat()}.csv"
    return csv_file_response(csv_text, filename)


__all__ = ["router"]
