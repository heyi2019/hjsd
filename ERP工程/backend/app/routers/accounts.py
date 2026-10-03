"""账号库存 CRUD。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Account, Order
from app.schemas import AccountCreate, AccountOut

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.get("", response_model=list[AccountOut])
def list_accounts(status: str = None, keyword: str = None, db: Session = Depends(get_db)):
    q = db.query(Account)
    if status:
        q = q.filter(Account.status == status)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(Account.account_info.like(like) | Account.account_pwd.like(like)
                     | Account.bind_phone.like(like))
    return q.order_by(Account.recycle_date.desc()).all()


@router.post("", response_model=AccountOut, status_code=201)
def create_account(acc: AccountCreate, db: Session = Depends(get_db)):
    db_acc = Account(**acc.model_dump())
    db.add(db_acc)
    db.commit()
    db.refresh(db_acc)
    return db_acc


@router.get("/{acc_id}", response_model=AccountOut)
def get_account(acc_id: int, db: Session = Depends(get_db)):
    acc = db.get(Account, acc_id)
    if not acc:
        raise HTTPException(404, "账号不存在")
    return acc


@router.put("/{acc_id}", response_model=AccountOut)
def update_account(acc_id: int, acc: AccountCreate, db: Session = Depends(get_db)):
    db_acc = db.get(Account, acc_id)
    if not db_acc:
        raise HTTPException(404, "账号不存在")
    for k, v in acc.model_dump().items():
        setattr(db_acc, k, v)
    db.commit()
    db.refresh(db_acc)
    return db_acc


@router.delete("/{acc_id}", status_code=204)
def delete_account(acc_id: int, db: Session = Depends(get_db)):
    """删除账号。若已有订单引用则拒绝，避免订单悬空。"""
    db_acc = db.get(Account, acc_id)
    if not db_acc:
        raise HTTPException(404, "账号不存在")
    linked = db.query(Order).filter(Order.account_id == acc_id).count()
    if linked:
        raise HTTPException(400, f"该账号已被 {linked} 笔订单引用，无法删除")
    db.delete(db_acc)
    db.commit()
