"""accounts.router：账号台账 API（ACC-01）。

账号状态与成本由订单事件驱动，本模块**不提供**改状态/改成本入口（ACC-01-03/04）。
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    CurrentUser,
    require_permissions,
)
from app.accounts import service

router = APIRouter(tags=["ACC-01 账号台账"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)


class AccountCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    game_account: str = Field(min_length=1, max_length=128)
    platform: str | None = None
    region: str | None = None
    risk_level: str | None = None
    note: str | None = None


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account_no: str
    game_account: str | None = None
    platform: str | None = None
    status: str
    cost_amount: Decimal
    risk_level: str | None = None


def _actor(user: CurrentUser) -> str:
    return user.username


@router.get("/accounts", response_model=list[AccountOut])
def list_accounts(
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[AccountOut]:
    return [AccountOut.model_validate(item) for item in service.list_accounts(db, status=status)]


@router.post("/accounts", response_model=AccountOut, status_code=201)
def create_account(
    payload: AccountCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> AccountOut:
    item = service.create_account(
        db,
        game_account=payload.game_account,
        actor=_actor(user),
        platform=payload.platform,
        region=payload.region,
        risk_level=payload.risk_level,
        note=payload.note,
    )
    return AccountOut.model_validate(item)


@router.get("/accounts/inventory")
def inventory(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> dict:
    """库存健康表 R1：只统计在库与分期中的真实占用。"""
    rows = service.inventory(db)
    total = sum((row["cost_amount"] for row in rows), Decimal("0"))
    return {"items": rows, "count": len(rows), "total_cost": str(total)}


__all__ = ["router"]
