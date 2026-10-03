"""报表：双荷包 / 月度真实利润 / 库存占用。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Account, CashFlow, Order
from app.services import (
    OPERATION_COST_CATEGORIES,
    monthly_profit,
    wallet_summary,
)

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/wallet")
def get_wallet(db: Session = Depends(get_db)):
    return wallet_summary(db)


@router.get("/monthly-profit")
def get_monthly_profit(year: int = Query(...), month: int = Query(...), db: Session = Depends(get_db)):
    return {"year": year, "month": month, "profit": monthly_profit(db, year, month)}


@router.get("/monthly-profit/table")
def get_monthly_profit_table(db: Session = Depends(get_db)):
    """按月真实利润表（T07 核心报表：已实现利润 − 运营消耗，本金不计入）。

    单月查询不足以支撑趋势复盘，故补全量月度视图。
    """
    profit_rows = (
        db.query(
            func.strftime("%Y-%m", Order.date).label("ym"),
            func.coalesce(func.sum(Order.profit), 0),
        )
        .group_by("ym")
        .all()
    )
    cost_rows = (
        db.query(
            func.strftime("%Y-%m", CashFlow.date).label("ym"),
            func.coalesce(func.sum(CashFlow.amount), 0),
        )
        .filter(CashFlow.category.in_(OPERATION_COST_CATEGORIES),
                CashFlow.direction == "支出")
        .group_by("ym")
        .all()
    )
    profit_map = {ym: float(v) for ym, v in profit_rows if ym}
    cost_map = {ym: float(v) for ym, v in cost_rows if ym}

    months = sorted(set(profit_map) | set(cost_map))
    rows = []
    running = 0.0
    for ym in months:
        p, c = profit_map.get(ym, 0.0), cost_map.get(ym, 0.0)
        net = round(p - c, 2)
        running += net
        rows.append({"month": ym, "realized_profit": round(p, 2),
                     "operation_cost": round(c, 2), "net_profit": net,
                     "cumulative": round(running, 2)})
    return {"rows": rows, "total_net_profit": round(sum(r["net_profit"] for r in rows), 2)}


@router.get("/inventory")
def get_inventory(db: Session = Depends(get_db)):
    in_stock = db.query(Account).filter(Account.status == "在库").all()
    occupied_principal = func.coalesce(func.sum(Account.principal), 0)
    total_occupied = db.query(occupied_principal).filter(Account.status == "在库").scalar() or 0
    expected_profit = sum((a.sale_price - a.principal for a in in_stock), start=0)
    return {
        "in_stock_count": len(in_stock),
        "occupied_principal": total_occupied,
        "expected_profit": expected_profit,
        "accounts": [
            {"id": a.id, "principal": a.principal, "sale_price": a.sale_price,
             "channel": a.channel, "recycler": a.recycler}
            for a in in_stock
        ],
    }
