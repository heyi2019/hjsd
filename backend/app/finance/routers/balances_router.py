"""资金账户余额查询 API（/pools/balances、/pools/{pool_id}/balance）。

原在 orders/router.py；2026-11-18 P0-A 归位到 finance 域：路径语义本就是
资金账户余额而非订单资源，只是历史上错放在订单路由里。URL 不变，前端零改动。
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import NotFound
from app.core.security import PERM_FINANCE_READ, CurrentUser
from app.settings.auth.session import require_permissions
from app.finance import schemas
from app.finance.balances import pool_balance, pool_balance_summary

router = APIRouter(tags=["资金账户余额"])
read_finance = require_permissions(PERM_FINANCE_READ)


@router.get("/pools/balances", response_model=schemas.PoolBalanceListOut)
def pool_balances_summary(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_finance,
) -> schemas.PoolBalanceListOut:
    """全部可见资金账户的余额卡片 + 汇总（一次请求，替代前端逐池 N+1 与本地累加）。"""
    items, totals = pool_balance_summary(db, user=_user)
    return schemas.PoolBalanceListOut(
        items=[schemas.PoolBalanceOut.model_validate(item) for item in items],
        totals=schemas.PoolBalanceTotalsOut.model_validate(totals),
    )


@router.get("/pools/{pool_id}/balance", response_model=schemas.PoolBalanceOut)
def pool_balance_detail(
    pool_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_finance,
) -> schemas.PoolBalanceOut:
    if not _user.can_see_pool(pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    return schemas.PoolBalanceOut.model_validate(
        pool_balance(db, pool_id, user=_user)
    )


__all__ = ["router"]
