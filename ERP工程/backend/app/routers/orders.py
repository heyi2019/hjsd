"""订单中心：双字段录入 + 库存联动 + 自动写现金流。
核心：卖出单(principal>0) 自动将关联账号置为已售，并生成现金流水（本金回款+利润）。
荷包余额由 ProfitService 从 orders 聚合得出（视图，不写）。
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Account, CashFlow, Order
from app.schemas import OrderCreate, OrderOut

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("", response_model=list[OrderOut])
def list_orders(type: str = None, db: Session = Depends(get_db)):
    q = db.query(Order)
    if type:
        q = q.filter(Order.type == type)
    return q.order_by(Order.date.desc()).all()


@router.post("", response_model=OrderOut, status_code=201)
def create_order(order: OrderCreate, db: Session = Depends(get_db)):
    # total=principal+profit 的旧校验已移除（total 是成交总额 gross，
    # 二者之间夹第三方分成，不构成恒等式）。校验统一下沉到 schemas。
    db_order = Order(**order.model_dump())
    db.add(db_order)
    db.flush()

    # 联动：卖出单回本 -> 账号置已售
    if order.type == "回收" and order.account_id:
        acc = db.get(Account, order.account_id)
        if acc:
            acc.status = "已售"

    # 自动写现金流（用于流水展示；荷包聚合以 orders 为准）
    # source='order' 标记来源，使其可与手工记账区分开（见 CashFlow.source）
    if order.principal != 0:
        db.add(CashFlow(
            date=order.date, category="账号回收",
            direction="收入" if order.principal > 0 else "支出",
            amount=abs(order.principal), order_id=db_order.id, source="order",
            remark=f"订单#{db_order.id} 本金",
        ))
    if order.profit != 0:
        db.add(CashFlow(
            date=order.date, category="账号回收",
            direction="收入", amount=order.profit, order_id=db_order.id,
            source="order", remark=f"订单#{db_order.id} 利润",
        ))

    db.commit()
    db.refresh(db_order)
    return db_order


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db)):
    o = db.get(Order, order_id)
    if not o:
        raise HTTPException(404, "订单不存在")
    return o


@router.delete("/{order_id}", status_code=204)
def delete_order(order_id: int, db: Session = Depends(get_db)):
    """删除订单，并级联清理由 create_order 联动生成的流水。

    按 `source='order'` 删，而不是按 order_id 删：SQLite 默认不启用外键约束，
    ORM 删除时只会把 order_id 置为 NULL、行仍留存 —— 那既不是干净级联，
    也会把订单现金侧混进手工流水里。此处显式按来源删，才是真的清理干净。
    """
    o = db.get(Order, order_id)
    if not o:
        raise HTTPException(404, "订单不存在")
    db.query(CashFlow).filter(
        CashFlow.order_id == order_id, CashFlow.source == "order"
    ).delete(synchronize_session=False)
    # 账号回滚：若该账号已无其他订单引用，恢复为在库
    if o.account_id:
        remaining = db.query(Order).filter(
            Order.account_id == o.account_id, Order.id != order_id).count()
        if remaining == 0:
            acc = db.get(Account, o.account_id)
            if acc:
                acc.status = "在库"
    db.delete(o)
    db.commit()
