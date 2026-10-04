"""分期合约 CRUD（T08）。

分期不强制挂账号：真实数据里 installment.account_id 为空，
只有金额/期数/补款时间，故保持可选关联。
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Installment
from app.schemas import InstallmentCreate, InstallmentOut

router = APIRouter(prefix="/installments", tags=["installments"])


@router.get("", response_model=list[InstallmentOut])
def list_installments(status: str = None, db: Session = Depends(get_db)):
    q = db.query(Installment)
    if status:
        q = q.filter(Installment.status == status)
    return q.order_by(Installment.next_pay_date.is_(None), Installment.next_pay_date).all()


@router.post("", response_model=InstallmentOut, status_code=201)
def create_installment(inst: InstallmentCreate, db: Session = Depends(get_db)):
    if inst.periods > 0 and inst.down_payment > inst.principal:
        raise HTTPException(400, "首付不得超过本金")
    row = Installment(**inst.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/{inst_id}", response_model=InstallmentOut)
def get_installment(inst_id: int, db: Session = Depends(get_db)):
    row = db.get(Installment, inst_id)
    if not row:
        raise HTTPException(404, "分期记录不存在")
    return row


@router.delete("/{inst_id}", status_code=204)
def delete_installment(inst_id: int, db: Session = Depends(get_db)):
    row = db.get(Installment, inst_id)
    if not row:
        raise HTTPException(404, "分期记录不存在")
    db.delete(row)
    db.commit()


@router.get("/overdue/list", response_model=list[InstallmentOut])
def list_overdue(today: date | None = None, db: Session = Depends(get_db)):
    """逾期未补款：状态非已完成 且 下次补款日已过。"""
    ref = today or date.today()
    return (
        db.query(Installment)
        .filter(
            Installment.status != "已完成",
            Installment.next_pay_date.isnot(None),
            Installment.next_pay_date < ref,
        )
        .order_by(Installment.next_pay_date)
        .all()
    )
