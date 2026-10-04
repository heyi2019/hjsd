"""记账流水 CRUD。"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import CashFlow
from app.schemas import CashFlowCreate, CashFlowOut

router = APIRouter(prefix="/cashflow", tags=["cashflow"])


@router.get("", response_model=list[CashFlowOut])
def list_cashflow(
    category: str = None,
    year: Optional[int] = None,
    month: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """按类别 / 年月筛选。年月筛选是记账页的主视图（T04 验收要求）。

    注意：SQLite 无 `year()`/`month()` 函数（那是 MySQL 语法），
    跨库写法统一走 strftime，见 services._ym_expr。
    """
    q = db.query(CashFlow)
    if category:
        q = q.filter(CashFlow.category == category)
    if year:
        q = q.filter(func.strftime("%Y", CashFlow.date) == f"{int(year):04d}")
    if month:
        q = q.filter(func.strftime("%m", CashFlow.date) == f"{int(month):02d}")
    return q.order_by(CashFlow.date.desc()).all()


@router.post("", response_model=CashFlowOut, status_code=201)
def create_cashflow(cf: CashFlowCreate, db: Session = Depends(get_db)):
    db_cf = CashFlow(**cf.model_dump())
    db.add(db_cf)
    db.commit()
    db.refresh(db_cf)
    return db_cf


@router.get("/{cf_id}", response_model=CashFlowOut)
def get_cashflow(cf_id: int, db: Session = Depends(get_db)):
    cf = db.get(CashFlow, cf_id)
    if not cf:
        raise HTTPException(404, "记录不存在")
    return cf


@router.put("/{cf_id}", response_model=CashFlowOut)
def update_cashflow(cf_id: int, cf: CashFlowCreate, db: Session = Depends(get_db)):
    row = db.get(CashFlow, cf_id)
    if not row:
        raise HTTPException(404, "记录不存在")
    for k, v in cf.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{cf_id}", status_code=204)
def delete_cashflow(cf_id: int, db: Session = Depends(get_db)):
    """删除手工流水。

    订单联动生成的流水（source='order'）由订单侧级联管理，
    此处拒绝单独删除，避免留下破坏荷包口径的孤儿流水。
    """
    row = db.get(CashFlow, cf_id)
    if not row:
        raise HTTPException(404, "记录不存在")
    if row.source == "order" or row.order_id is not None:
        raise HTTPException(400, "该流水由订单联动生成，请在订单侧处理")
    db.delete(row)
    db.commit()
