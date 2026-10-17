"""reporting.router：R1/R2/R3/R5、资金日报与订单利润（RPT-01）。"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_REPORT_READ,
    CurrentUser,
    get_current_user,
    require_permissions,
)
from app.reporting import service

router = APIRouter(tags=["reporting"])
read_access = require_permissions(PERM_REPORT_READ)


@router.get("/reports/inventory-health")
def inventory_health(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> dict:
    """R1 库存健康表（回收与代挂进入库存，提号不进入库存）。"""
    return service.r1_inventory_health(db, user=user)


@router.get("/reports/monthly-pnl")
def monthly_pnl(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> dict:
    """R2 月度经营损益（账号 COST 不进运营费用）。"""
    return service.r2_monthly_pnl(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/commission")
def commission(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> dict:
    """R3 提成对账：人员可钻取到每一单。"""
    return service.r3_commission_reconciliation(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/business-pnl")
def business_pnl(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> dict:
    """R5 业务级损益：未归集返点独立列，不摊给业务。"""
    return service.r5_business_pnl(db, from_date=from_date, to_date=to_date, user=user)


@router.get("/reports/daily-funds")
def daily_funds(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    on: date | None = Query(default=None),
) -> dict:
    """资金日报：与 FIN-01 同日口径一致。"""
    return service.daily_funds_report(db, on=on, user=user)


@router.get("/reports/order-profit")
def order_profit(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> dict:
    """订单利润明细：合计与 R5 对应维度一致。"""
    return service.order_profit_detail(db, from_date=from_date, to_date=to_date, user=user)


__all__ = ["router"]
