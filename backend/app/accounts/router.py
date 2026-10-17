"""accounts.router：账号台账 API（ACC-01）。

账号状态与成本由订单事件驱动，本模块**不提供**改状态/改成本入口（ACC-01-03/04）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.schemas import RequestModel
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    CurrentUser,
    owner_scope_filter,
    require_permissions,
)
from app.accounts import service
from app.domain.foundation import Pool
from app.domain.parties import Counterparty, OrderCounterpartyRole
from app.domain.trade import (
    Account,
    Cashflow,
    Order,
    OrderEvent,
    RebateRecord,
    RebateSettlement,
)

router = APIRouter(tags=["ACC-01 账号台账"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    inventory_no: str
    source_order_no: str | None = None
    game_account: str | None = None
    game_type: str | None = None
    business_mode: str | None = None
    inventory_type: str | None = None
    game_password: str | None = None
    channel_region: str | None = None
    bound_phone: str | None = None
    has_secondary: bool | None = None
    platform: str | None = None
    note: str | None = None
    account_description: str | None = None
    account_images: list[str] | None = None
    status: str
    cost_amount: Decimal
    buy_date: date | None = None
    created_by: str
    created_at: datetime


class AccountProfileUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    game_account: str | None = Field(default=None, max_length=128)
    game_type: str | None = Field(default=None, max_length=64)
    game_password: str | None = Field(default=None, max_length=256)
    channel_region: str | None = Field(default=None, max_length=128)
    bound_phone: str | None = Field(default=None, max_length=64)
    has_secondary: bool | None = None
    platform: str | None = Field(default=None, max_length=64)
    account_description: str | None = Field(default=None, max_length=2000)
    account_images: list[str] | None = Field(default=None, max_length=9)
    note: str | None = None


class ExecutionCashflowOut(BaseModel):
    flow_no: str
    pool_name: str | None = None
    occurred_on: date
    occurred_at: datetime
    direction: str
    nature: str
    category: str
    amount: Decimal
    note: str | None = None
    operator: str


class ExecutionEventOut(BaseModel):
    id: int
    event_no: str
    event_type: str
    amount: Decimal
    occurred_on: date
    occurred_at: datetime
    created_at: datetime
    posted_at: datetime | None = None
    offset_event_id: int | None = None
    portion: str
    delivery_mode: str | None = None
    is_posted: bool
    reason: str | None = None
    note: str | None = None
    cashflow: ExecutionCashflowOut | None = None
    operator: str


class ExecutionCounterpartyOut(BaseModel):
    id: int
    display_name: str
    role: str


class ExecutionRebateOut(BaseModel):
    id: int
    rebate_no: str
    rebate_type: str
    channel: str | None = None
    rate: Decimal
    base_amount: Decimal
    status: str
    collected_on: date
    collected_at: datetime
    settlements: list["ExecutionRebateSettlementOut"] = Field(default_factory=list)


class ExecutionRebateSettlementOut(BaseModel):
    id: int
    settlement_no: str
    settled_on: date
    settled_at: datetime
    gross_amount: Decimal
    platform_fee: Decimal
    net_amount: Decimal
    cashflow_id: int | None = None
    reversal_of_id: int | None = None
    note: str | None = None
    operator: str


class AccountExecutionOrderOut(BaseModel):
    order_id: int
    order_no: str
    order_type: str
    trade_date: date
    created_at: datetime
    status: str
    note: str | None = None
    counterparties: list[ExecutionCounterpartyOut] = Field(default_factory=list)
    rebates: list[ExecutionRebateOut] = Field(default_factory=list)
    events: list[ExecutionEventOut]
    operator: str


class AccountExecutionDetailOut(BaseModel):
    account: AccountOut
    orders: list[AccountExecutionOrderOut]


INVENTORY_SOURCE_ORDER_TYPES = frozenset({"HS", "DG"})


def _actor(user: CurrentUser) -> str:
    return user.username


def _source_orders(
    db: Session, account_ids: list[int], user: CurrentUser | None = None
) -> dict[int, Order]:
    """解析标准订单数据中的库存来源；TH 提号不建立库存账号。"""
    if not account_ids:
        return {}
    stmt = select(Order).where(Order.account_id.in_(account_ids))
    scope = owner_scope_filter(Order.owner_id, user, db)
    if scope is not None:
        stmt = stmt.where(scope)
    orders = list(db.scalars(stmt.order_by(Order.trade_date.desc(), Order.id.desc())).all())
    if not orders:
        return {}
    order_ids = [order.id for order in orders]
    buy_order_ids = set(
        db.scalars(
            select(OrderEvent.order_id).where(
                OrderEvent.order_id.in_(order_ids),
                OrderEvent.event_type == "BUY",
                OrderEvent.is_posted.is_(True),
            )
        ).all()
    )
    inventory_orders: dict[int, Order] = {}
    for order in orders:
        if order.account_id is None:
            continue
        if order.order_type == "DG" or (
            order.id in buy_order_ids and order.order_type in INVENTORY_SOURCE_ORDER_TYPES
        ):
            inventory_orders.setdefault(order.account_id, order)
    return {
        account_id: inventory_orders[account_id]
        for account_id in account_ids
        if account_id in inventory_orders
    }


def _account_output(
    account: Account,
    source_order: Order | None = None,
    *,
    include_credentials: bool = False,
) -> AccountOut:
    """统一补齐库存来源订单；业务与类型以标准导入的账号字段为准。"""
    output = AccountOut.model_validate(account)
    if not include_credentials:
        output.game_password = None
    if source_order is None:
        return output
    output.source_order_no = source_order.order_no
    return output


def _account_outputs(
    db: Session,
    accounts: list[Account],
    user: CurrentUser | None = None,
    *,
    include_credentials: bool = False,
) -> list[AccountOut]:
    """批量补齐库存来源订单，避免列表逐账号查询。"""
    source_orders = _source_orders(db, [account.id for account in accounts], user)
    return [
        _account_output(
            account,
            source_orders.get(account.id),
            include_credentials=include_credentials,
        )
        for account in accounts
    ]


@router.get("/accounts", response_model=list[AccountOut])
def list_accounts(
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[AccountOut]:
    items = service.list_accounts(db, status=status, user=_user)
    return _account_outputs(
        db,
        items,
        _user,
        include_credentials=_user.has(PERM_ORDER_CREATE),
    )


@router.patch("/accounts/{account_id}", response_model=AccountOut)
def update_account_profile(
    account_id: int,
    payload: AccountProfileUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> AccountOut:
    service.get_account(db, account_id, user)
    changes = {
        field: getattr(payload, field)
        for field in payload.model_fields_set
    }
    item = service.update_account_profile(
        db, account_id, actor=_actor(user), user=user, **changes
    )
    return AccountOut.model_validate(item)


@router.get("/accounts/inventory")
def inventory(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> dict:
    """库存健康表 R1：只统计在库与分期中的真实占用。"""
    rows = service.inventory(db, user=_user)
    total = sum((row["cost_amount"] for row in rows), Decimal("0"))
    return {"items": rows, "count": len(rows), "total_cost": str(total)}


@router.get("/accounts/{account_id}/execution-detail", response_model=AccountExecutionDetailOut)
def execution_detail(
    account_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> AccountExecutionDetailOut:
    """查询库存账号关联的全部订单、已过账事件和资金流水。"""
    account = service.get_account(db, account_id, _user)
    order_stmt = select(Order).where(Order.account_id == account_id)
    order_scope = owner_scope_filter(Order.owner_id, _user, db)
    if order_scope is not None:
        order_stmt = order_stmt.where(order_scope)
    orders = list(db.scalars(order_stmt.order_by(Order.id)).all())
    order_ids = [item.id for item in orders]
    counterparties_by_order: dict[int, list[ExecutionCounterpartyOut]] = {}
    if order_ids:
        for role, counterparty in db.execute(
            select(OrderCounterpartyRole, Counterparty)
            .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
            .where(OrderCounterpartyRole.order_id.in_(order_ids))
            .order_by(OrderCounterpartyRole.id)
        ).all():
            counterparties_by_order.setdefault(role.order_id, []).append(
                ExecutionCounterpartyOut(
                    id=counterparty.id,
                    display_name=counterparty.display_name,
                    role=role.role,
                )
            )
    rebates_by_order: dict[int, list[ExecutionRebateOut]] = {}
    if order_ids:
        rebates = list(db.scalars(
            select(RebateRecord)
            .where(RebateRecord.source_order_id.in_(order_ids))
            .order_by(RebateRecord.id)
        ).all())
        settlement_by_rebate: dict[int, list[ExecutionRebateSettlementOut]] = {}
        rebate_ids = [rebate.id for rebate in rebates]
        if rebate_ids:
            settlements = db.scalars(
                select(RebateSettlement)
                .where(RebateSettlement.rebate_record_id.in_(rebate_ids))
                .order_by(RebateSettlement.rebate_record_id, RebateSettlement.id)
            ).all()
            for settlement in settlements:
                settlement_by_rebate.setdefault(settlement.rebate_record_id, []).append(
                    ExecutionRebateSettlementOut(
                        id=settlement.id,
                        settlement_no=settlement.settlement_no,
                        settled_on=settlement.settled_on,
                        settled_at=settlement.created_at,
                        gross_amount=settlement.gross_amount,
                        platform_fee=settlement.platform_fee,
                        net_amount=settlement.net_amount,
                        cashflow_id=settlement.cashflow_id,
                        reversal_of_id=settlement.reversal_of_id,
                        note=settlement.note,
                        operator=settlement.created_by,
                    )
                )
        for rebate in rebates:
            if rebate.source_order_id is None:
                continue
            rebates_by_order.setdefault(rebate.source_order_id, []).append(
                ExecutionRebateOut(
                    id=rebate.id,
                    rebate_no=rebate.rebate_no,
                    rebate_type=rebate.rebate_type,
                    channel=rebate.channel,
                    rate=rebate.rate,
                    base_amount=rebate.base_amount,
                    status=rebate.status,
                    collected_on=rebate.collected_on,
                    collected_at=rebate.created_at,
                    settlements=settlement_by_rebate.get(rebate.id, []),
                )
            )
    events = list(
        db.scalars(
            select(OrderEvent)
            .where(OrderEvent.order_id.in_(order_ids), OrderEvent.is_posted.is_(True))
            .order_by(OrderEvent.occurred_on, OrderEvent.id)
        ).all()
    ) if order_ids else []
    event_ids = [item.id for item in events]
    flow_by_event: dict[int, ExecutionCashflowOut] = {}
    if event_ids:
        for flow, pool in db.execute(
            select(Cashflow, Pool)
            .join(Pool, Pool.id == Cashflow.pool_id)
            .where(Cashflow.order_event_id.in_(event_ids))
        ).all():
            flow_by_event[flow.order_event_id] = ExecutionCashflowOut(
                flow_no=flow.flow_no,
                pool_name=pool.name,
                occurred_on=flow.occurred_on,
                occurred_at=flow.created_at,
                direction=flow.direction,
                nature=flow.nature,
                category=flow.category,
                amount=flow.amount,
                note=flow.note,
                operator=flow.created_by,
            )
    events_by_order: dict[int, list[ExecutionEventOut]] = {}
    for event in events:
        events_by_order.setdefault(event.order_id, []).append(
            ExecutionEventOut(
                id=event.id,
                event_no=event.event_no,
                event_type=event.event_type,
                amount=event.amount,
                occurred_on=event.occurred_on,
                occurred_at=event.posted_at or event.created_at,
                created_at=event.created_at,
                posted_at=event.posted_at,
                offset_event_id=event.offset_event_id,
                portion=event.portion,
                delivery_mode=event.delivery_mode,
                is_posted=event.is_posted,
                reason=event.reason,
                note=event.note,
                cashflow=flow_by_event.get(event.id),
                operator=event.created_by,
            )
        )
    return AccountExecutionDetailOut(
        account=_account_outputs(
            db,
            [account],
            _user,
            include_credentials=_user.has(PERM_ORDER_CREATE),
        )[0],
        orders=[
            AccountExecutionOrderOut(
                order_id=order.id,
                order_no=order.order_no,
                order_type=order.order_type,
                trade_date=order.trade_date,
                created_at=order.created_at,
                status=order.status,
                note=order.note,
                counterparties=counterparties_by_order.get(order.id, []),
                rebates=rebates_by_order.get(order.id, []),
                events=events_by_order.get(order.id, []),
                operator=order.created_by,
            )
            for order in orders
        ],
    )


__all__ = ["router"]
