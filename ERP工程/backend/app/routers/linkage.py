"""订单 <-> 账号 关联管理。

为什么需要独立模块：源数据里两表**没有任何可用的自动关联键**
- orders.account_id / installments.account_id 迁移后全为 NULL
- 回收员姓名体系不同源：orders 用「小轩/三三/小周」，accounts 用
  「企业用户_1210076649/蒋丞选手」，交集为空
- query_no 仅 6/89 有值
- 按 (日期+本金) 启发式只能匹配 6/89

结论：不做不可靠的自动猜测，改为「人工指派 + 缺口可见」。
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Account, Order
from app.schemas import LinkRequest

router = APIRouter(prefix="/linkage", tags=["linkage"])


def _release_account(acc_id: int, exclude_order_id: int, db: Session) -> None:
    """若账号已无其他订单引用，回滚为在库。"""
    remaining = db.query(Order).filter(
        Order.account_id == acc_id, Order.id != exclude_order_id).count()
    if remaining == 0:
        acc = db.get(Account, acc_id)
        if acc:
            acc.status = "在库"


@router.get("/gap")
def linkage_gap(db: Session = Depends(get_db)):
    """关联缺口总览：哪些订单没挂账号、哪些账号还没被关联。"""
    total_orders = db.query(Order).count()
    unlinked = db.query(Order).filter(Order.account_id.is_(None)).all()
    linked_ids = {
        a for (a,) in db.query(Order.account_id)
        .filter(Order.account_id.isnot(None)).all()
    }
    accounts = db.query(Account).order_by(Account.recycle_date.desc()).all()

    return {
        "orders_total": total_orders,
        "orders_unlinked": len(unlinked),
        "orders_link_rate": round((total_orders - len(unlinked)) / max(total_orders, 1), 4),
        "accounts_total": len(accounts),
        "accounts_linked": len(linked_ids),
        "accounts_unsold": [
            {"id": a.id, "recycle_date": str(a.recycle_date),
             "principal": float(a.principal), "sale_price": float(a.sale_price),
             "status": a.status, "account_info": a.account_info[:40],
             "channel": a.channel}
            for a in accounts if a.id not in linked_ids
        ],
        "unlinked_orders": [
            {"id": o.id, "date": str(o.date), "type": o.type,
             "principal": float(o.principal), "profit": float(o.profit),
             "total": float(o.total), "recycler": o.recycler,
             "seller": o.seller, "remark": (o.remark or "")[:40]}
            for o in unlinked
        ],
    }


@router.get("/candidates/{order_id}")
def link_candidates(order_id: int, db: Session = Depends(get_db)):
    """为某订单推荐候选账号：回收日期临近 + 本金接近。

    这是**建议**而非自动执行——源数据不足以可靠判定归属，
    最终仍需人工确认后调用 POST /linkage/order/{id}/link。
    """
    o = db.get(Order, order_id)
    if not o:
        raise HTTPException(404, "订单不存在")
    if o.type != "回收":
        return {"order_id": order_id, "candidates": [],
                "note": "仅「回收」类订单需关联账号；代挂/返点/提号类无库存实体。"}

    lo, hi = o.date - timedelta(days=3), o.date + timedelta(days=3)
    q = db.query(Account).filter(
        Account.recycle_date >= lo, Account.recycle_date <= hi)
    if o.principal and o.principal > 0:
        p = float(o.principal)
        q = q.filter(Account.principal.between(p * 0.9, p * 1.1))

    cands = q.order_by(Account.recycle_date).limit(10).all()
    return {
        "order_id": order_id,
        "candidates": [
            {"id": a.id, "recycle_date": str(a.recycle_date),
             "principal": float(a.principal), "sale_price": float(a.sale_price),
             "status": a.status, "account_info": a.account_info[:40],
             "channel": a.channel,
             "exact_match": str(a.recycle_date) == str(o.date)
             and abs(float(a.principal) - float(o.principal)) < 0.01}
            for a in cands
        ],
        "note": "候选仅供参考，源数据无唯一关联键，请人工确认",
    }


@router.post("/order/{order_id}/link")
def link_order(order_id: int, payload: LinkRequest, db: Session = Depends(get_db)):
    """人工把订单挂到账号上，并同步账号状态。"""
    o = db.get(Order, order_id)
    if not o:
        raise HTTPException(404, "订单不存在")
    acc = db.get(Account, payload.account_id)
    if not acc:
        raise HTTPException(404, "账号不存在")
    if o.account_id == acc.id:
        return {"order_id": order_id, "account_id": acc.id, "changed": False,
                "note": "已关联，未做变更"}

    prev = o.account_id
    if prev is not None:
        _release_account(prev, order_id, db)

    o.account_id = acc.id
    if o.type == "回收":
        acc.status = "已售"
    db.commit()
    return {"order_id": order_id, "account_id": acc.id, "changed": True,
            "previous_account_id": prev}


@router.delete("/order/{order_id}/link")
def unlink_order(order_id: int, db: Session = Depends(get_db)):
    """解除关联，并把账号状态回滚（在库）。"""
    o = db.get(Order, order_id)
    if not o:
        raise HTTPException(404, "订单不存在")
    if o.account_id is None:
        return {"order_id": order_id, "changed": False, "note": "本就未关联"}
    acc_id = o.account_id
    o.account_id = None
    _release_account(acc_id, order_id, db)
    db.commit()
    return {"order_id": order_id, "changed": True, "released_account_id": acc_id}
