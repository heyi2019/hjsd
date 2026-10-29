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
from app.lists import service as list_columns_service
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
) -> CommissionOut:
    """R3 提成对账：人员可钻取到每一单。"""
    return service.r3_commission_reconciliation(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/business-pnl", response_model=BusinessPnlOut)
def business_pnl(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> BusinessPnlOut:
    """R5 业务级损益：未归集返点独立列，不摊给业务。"""
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
    scope = report_scope(report_name)
    csv_columns: list[tuple[str, str, bool]] | None = None
    value_labels: dict[str, dict[str, str]] | None = None
    if scope is not None:
        config = list_columns_service.get_config(db, scope.code)
        # 传全量（含可见标记）：只传可见列会让隐藏列被当成「未登记键」又追加回去
        csv_columns = [
            (column["key"], column["label"], column["is_visible"])
            for column in config["columns"]
        ]
        # 枚举列的值也翻成中文：字典来自 option_sets，列注册表只声明归属
        value_labels = list_columns_service.get_value_labels(db, scope.code)
        # 自定义列：界面从行扩展字段（form_extra / extra_values）取值，报表行本身没有
        # `extra:xxx` 这个平铺键。这里把值注入明细行，让 report_csv 的「已登记键」判断
        # 能命中，保证「界面看到的列 = 导出的列」；隐藏列仍由 csv_columns 的 visible 剔除。
        custom_sources = {
            column["key"]: column["source_key"]
            for column in config["columns"]
            if column.get("custom") and column.get("source_key")
        }
        if custom_sources:
            for item in report.get("items", []) or []:
                if not isinstance(item, dict):
                    continue
                extras = item.get("form_extra") or item.get("extra_values") or {}
                if not isinstance(extras, dict):
                    extras = {}
                for key, source_key in custom_sources.items():
                    item[key] = extras.get(source_key)
    item_count = len(report.get("items", [])) if isinstance(report.get("items"), list) else 0
    record_audit(
        db,
        action="REPORT_EXPORT",
        entity_type="report_export",
        entity_id=report_name,
        actor=user.username,
        after={
            "report_name": report_name,
            "item_count": item_count,
            "from": from_date.isoformat() if from_date else None,
            "to": to_date.isoformat() if to_date else None,
            "on": on.isoformat() if on else None,
            "column_count": (
                sum(1 for _key, _label, visible in csv_columns if visible)
                if csv_columns is not None
                else None
            ),
            "translated_columns": sorted(value_labels) if value_labels else [],
        },
    )
    filename = f"{report_name}-{date.today().isoformat()}.csv"
    return Response(
        content=service.report_csv(report, columns=csv_columns, value_labels=value_labels),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


__all__ = ["router"]
