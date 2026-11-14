"""SYS-01-02 全局搜索：只返回用户有权限看到的可跳转摘要。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.stocks.inventory import list_accounts
from app.core.database import get_db
from app.core.errors import Validation
from app.core.security import (
    PERM_COUNTERPARTY_READ,
    PERM_CUSTOMER_READ,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    CurrentUser,
    require_permissions,
)
from app.finance.rebates import list_rebates
from app.orders.queries import list_orders
from app.parties.counterparties import list_counterparties
from app.parties.customers import list_customers

router = APIRouter(tags=["SYS-01 通用能力"])
read_access = require_permissions(
    PERM_ORDER_CREATE,
    PERM_FINANCE_READ,
    PERM_CUSTOMER_READ,
    PERM_COUNTERPARTY_READ,
    require_all=False,
)


class SearchResult(BaseModel):
    type: str
    id: int
    code: str
    title: str
    subtitle: str | None = None
    route: str


class SearchResponse(BaseModel):
    query: str
    items: list[SearchResult] = Field(default_factory=list)
    total: int


def _matches(value: Any, query: str) -> bool:
    return value is not None and query.casefold() in str(value).casefold()


@router.get("/search", response_model=SearchResponse)
def global_search(
    q: str = Query(min_length=1, max_length=128),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> SearchResponse:
    query = q.strip()
    if not query:
        raise Validation("搜索关键词不能为空", details={"field": "q"})

    results: list[SearchResult] = []
    visible_orders = list_orders(db, user=user)
    order_by_account_id = {
        order.account_id: order
        for order in visible_orders
        if order.account_id is not None
    }
    for order in visible_orders:
        if _matches(order.order_no, query):
            results.append(
                SearchResult(
                    type="ORDER",
                    id=order.id,
                    code=order.order_no,
                    title=order.order_no,
                    subtitle=f"{order.order_type} · {order.status}",
                    route=f"/orders/{order.id}",
                )
            )

    for account in list_accounts(db, user=user):
        source_order = order_by_account_id.get(account.id)
        if source_order is None:
            continue
        if any(
            _matches(value, query)
            for value in (
                account.game_account,
                account.game_type,
                account.platform,
            )
        ):
            results.append(
                SearchResult(
                    type="ACCOUNT",
                    id=account.id,
                    code=account.game_account,
                    title=account.game_account,
                    subtitle=" · ".join(
                        value for value in (account.game_type, account.platform) if value
                    ) or account.status,
                    route=f"/orders/{source_order.id}",
                )
            )

    if user.has(PERM_CUSTOMER_READ):
        for customer in list_customers(db, keyword=query, user=user):
            results.append(
                SearchResult(
                    type="CUSTOMER",
                    id=customer.id,
                    code=customer.customer_no,
                    title=customer.display_name,
                    subtitle=customer.status,
                    route=f"/customers/{customer.id}",
                )
            )

    if user.has(PERM_COUNTERPARTY_READ):
        for counterparty in list_counterparties(db):
            if any(
                _matches(value, query)
                for value in (counterparty.counterparty_no, counterparty.display_name)
            ):
                results.append(
                    SearchResult(
                        type="COUNTERPARTY",
                        id=counterparty.id,
                        code=counterparty.counterparty_no,
                        title=counterparty.display_name,
                        subtitle=counterparty.type,
                        route=f"/counterparties/{counterparty.id}",
                    )
                )

    if user.has(PERM_FINANCE_READ):
        for rebate in list_rebates(db, user=user):
            if any(
                _matches(value, query)
                for value in (rebate.rebate_no, rebate.channel)
            ):
                results.append(
                    SearchResult(
                        type="REBATE",
                        id=rebate.id,
                        code=rebate.rebate_no,
                        title=rebate.rebate_no,
                        subtitle=rebate.channel or "返点明细",
                        route=f"/rebates/{rebate.id}",
                    )
                )

    results = results[:limit]
    return SearchResponse(query=query, items=results, total=len(results))


__all__ = ["router"]
