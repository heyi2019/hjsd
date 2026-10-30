"""accounts.router：账号台账 API（ACC-01）。

账号状态与成本由订单事件驱动，本模块**不提供**改状态/改成本入口（ACC-01-03/04）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.schemas import RequestModel
from app.core.security import (
    PERM_AUDIT_READ,
    PERM_FINANCE_READ,
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_ORDER_CREATE,
    PERM_ORDER_UPDATE,
    CurrentUser,
    owner_scope_filter,
    require_permissions,
)
from app.domain.enums import AuditAction
from app.lists.export import build_list_csv, csv_file_response
from app.stocks import service
from app.parties import service as parties_service
from app.domain.foundation import AuditLog, Pool
from app.domain.parties import Customer, Counterparty, OrderCounterpartyRole, OrderCustomerRole
from app.domain.users import User
from app.domain.trade import (
    Account,
    Cashflow,
    Order,
    OrderEvent,
    OrderFormField,
    RebateRecord,
    Installment,
    Reconciliation,
)
from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.schemas import PageOut
from app.orders import service as orders_service

router = APIRouter(tags=["ACC-01 账号台账"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
edit_execution = require_permissions(PERM_ORDER_UPDATE, PERM_FINANCE_ORDER_EVENT_POST)


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    stock_no: str | None = None
    source_order_id: int | None = None
    source_order_no: str | None = None
    game_account: str | None = None
    game_type: str | None = None
    business_mode: str | None = None
    inventory_type: str | None = None
    value_added_service: str | None = None
    game_password: str | None = None
    channel_region: str | None = None
    bound_phone: str | None = None
    has_secondary: bool | None = None
    platform: str | None = None
    note: str | None = None
    account_description: str | None = None
    account_images: list[str] | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    status: str
    cost_amount: Decimal
    buy_date: date | None = None
    created_by: str
    created_at: datetime


class AccountListOut(PageOut[AccountOut]):
    pass


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
    extra_values: dict[str, object] | None = None
    # 表单字段配置体系（INVEDIT 作用域）：合并进账号 form_extra。
    form_extra: dict[str, object] | None = None


class ExecutionEditItem(RequestModel):
    id: int = Field(gt=0)
    expected_amount: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    amount: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    note: str | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class ExecutionEditRequest(RequestModel):
    events: list[ExecutionEditItem] = Field(max_length=100)
    profile: AccountProfileUpdate | None = None


@router.patch("/stocks/{account_id}/execution-edit")
def update_execution_detail(
    account_id: int, payload: ExecutionEditRequest,
    db: Session = Depends(get_db), user: CurrentUser = edit_execution,
) -> dict[str, bool]:
    account = service.get_account(db, account_id, user)
    db.scalar(select(Account).where(Account.id == account_id).with_for_update())
    if len({item.id for item in payload.events}) != len(payload.events):
        raise Validation("同一执行记录不能重复修改")
    changes = []
    cost_delta = Decimal("0")
    for item in payload.events:
        event = db.scalar(select(OrderEvent).where(OrderEvent.id == item.id).with_for_update())
        order = orders_service.get_order(db, event.order_id, user) if event else None
        if event is None or order is None or order.account_id != account_id or not event.is_posted:
            raise NotFound("执行记录不存在")
        if Decimal(str(event.amount)) != item.expected_amount:
            raise Conflict("执行记录已被修改，请刷新后重试")
        if item.operator_user_ids is not None:
            ids = item.operator_user_ids
            if len(set(ids)) != len(ids):
                raise Validation("操作人不能重复选择")
            valid = set(db.scalars(select(User.id).where(User.id.in_(ids), User.is_active.is_(True))).all())
            if valid != set(ids):
                raise Validation("所选操作人不存在或已停用")
        flow = db.scalar(select(Cashflow).where(Cashflow.order_event_id == event.id).with_for_update())
        if flow is not None and not user.can_see_pool(flow.pool_id):
            raise NotFound("关联资金流水不存在")
        if item.amount == Decimal(str(event.amount)):
            changes.append((event, flow, item))
            continue
        if event.event_type not in {"BUY", "SELL", "COST"} or item.amount <= 0:
            raise Validation("该类型执行记录暂不支持修改金额")
        if flow is None:
            raise NotFound("关联资金流水不存在")
        if Decimal(str(flow.amount)) != Decimal(str(event.amount)):
            raise Validation("执行记录与关联流水金额不一致，请先核对")
        if (event.offset_event_id is not None or flow.reversal_of_id is not None
            or db.scalar(select(OrderEvent.id).where(OrderEvent.offset_event_id == event.id)) is not None
            or db.scalar(select(Cashflow.id).where(Cashflow.reversal_of_id == flow.id)) is not None):
            raise Validation("已冲销或被冲销的记录不能直接修改")
        if db.scalar(select(Installment.id).where(Installment.order_id == order.id)) is not None:
            raise Validation("关联分期的记录不能直接修改，请先处理分期")
        if db.scalar(select(RebateRecord.id).where(RebateRecord.source_order_id == order.id)) is not None:
            raise Validation("关联返点的记录不能直接修改，请先核对返点")
        if db.scalar(select(Reconciliation.id).where(Reconciliation.pool_id == flow.pool_id, Reconciliation.reconciled_on >= flow.occurred_on)) is not None:
            raise Validation("资金池已有后续对账记录，不能直接修改")
        if event.event_type in {"BUY", "COST"}:
            cost_delta += item.amount - Decimal(str(event.amount))
        changes.append((event, flow, item))
    if Decimal(str(account.cost_amount)) + cost_delta < 0:
        raise Validation("修改后库存成本不能为负数")
    if payload.profile is not None:
        account = service.update_account_profile(db, account_id, actor=user.username, user=user,
            **payload.profile.model_dump(exclude_unset=True))
    for event, flow, item in changes:
        before = {"amount": str(event.amount), "note": event.note, "operator_user_ids": event.operator_user_ids, "flow_amount": str(flow.amount) if flow else None, "flow_note": flow.note if flow else None}
        amount_changed = item.amount != Decimal(str(event.amount))
        event.amount = item.amount
        if "note" in item.model_fields_set:
            event.note = item.note
        if item.operator_user_ids is not None:
            event.operator_user_ids = item.operator_user_ids
        event.updated_by = user.username
        if flow is not None and amount_changed:
            flow.amount = item.amount
            flow.updated_by = user.username
        record_audit(db, action="ORDER_UPDATE", entity_type="inventory_event_edit", entity_id=event.id, actor=user.username,
                     before=before, after={"amount": str(item.amount), "note": event.note, "operator_user_ids": event.operator_user_ids, "flow_amount": str(flow.amount) if flow else None, "flow_note": flow.note if flow else None})
    account.cost_amount = Decimal(str(account.cost_amount)) + cost_delta
    if changes:
        account.updated_by = user.username
    db.flush()
    return {"ok": True}


class AccountInventoryOut(BaseModel):
    """库存健康接口的单行契约；与账号台账共享同一业务字段语义。"""

    model_config = ConfigDict(extra="forbid")

    account_id: int
    stock_no: str | None = None
    game_account: str | None = None
    business_mode: str | None = None
    inventory_type: str | None = None
    value_added_service: str | None = None
    platform: str | None = None
    status: str
    cost_amount: Decimal
    account_description: str | None = None
    account_images: list[str] = Field(default_factory=list)
    extra_values: dict[str, object] = Field(default_factory=dict)


class InventoryResponseOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[AccountInventoryOut]
    count: int
    total_cost: Decimal


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
    pool_id: int | None = None
    offset_event_id: int | None = None
    portion: str
    delivery_mode: str | None = None
    is_posted: bool
    reason: str | None = None
    note: str | None = None
    cashflow: ExecutionCashflowOut | None = None
    operator: str
    operator_user_ids: list[int] | None = None
    operator_names: list[str] = Field(default_factory=list)


class ExecutionCounterpartyOut(BaseModel):
    id: int
    display_name: str
    role: str


class ExecutionCustomerOut(BaseModel):
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


class AccountExecutionOrderOut(BaseModel):
    order_id: int
    order_no: str
    order_type: str
    trade_date: date
    created_at: datetime
    status: str
    account_platform: str | None = None
    note: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    extra_fields: list[dict[str, object]] = Field(default_factory=list)
    cashflows: list[ExecutionCashflowOut] = Field(default_factory=list)
    customers: list[ExecutionCustomerOut] = Field(default_factory=list)
    counterparties: list[ExecutionCounterpartyOut] = Field(default_factory=list)
    rebates: list[ExecutionRebateOut] = Field(default_factory=list)
    events: list[ExecutionEventOut]
    operator: str


class AccountAuditOut(BaseModel):
    id: int
    action: str
    entity_type: str
    entity_id: str
    actor: str
    reason: str | None = None
    occurred_at: datetime


class AccountExecutionDetailOut(BaseModel):
    account: AccountOut
    orders: list[AccountExecutionOrderOut]
    audit: list[AccountAuditOut] = Field(default_factory=list)


INVENTORY_SOURCE_ORDER_TYPES = frozenset({"HS", "TH", "DG"})


def _actor(user: CurrentUser) -> str:
    return user.username


def _source_orders(
    db: Session, account_ids: list[int], user: CurrentUser | None = None
) -> dict[int, Order]:
    """解析标准订单数据中的库存来源；HS/TH/DG 均可回溯到库存实体。"""
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
    fallback_orders: dict[int, Order] = {}
    for order in orders:
        if order.account_id is None:
            continue
        # 已取消/未过账的来源订单没有 BUY 事件，但库存记录仍应显示其订单编号，
        # 否则详情页会出现大量“订单号 -”。正式入库订单优先使用带 BUY 的记录。
        if order.order_type in INVENTORY_SOURCE_ORDER_TYPES:
            fallback_orders.setdefault(order.account_id, order)
        if order.order_type == "DG" or (
            order.id in buy_order_ids and order.order_type in INVENTORY_SOURCE_ORDER_TYPES
        ):
            inventory_orders.setdefault(order.account_id, order)
    return {
        account_id: inventory_orders.get(account_id) or fallback_orders[account_id]
        for account_id in account_ids
        if account_id in inventory_orders or account_id in fallback_orders
    }


def _account_output(
    account: Account,
    source_order: Order | None = None,
    *,
    include_credentials: bool = False,
    extra_values: dict[str, object] | None = None,
) -> AccountOut:
    """统一补齐库存来源订单；业务与类型以标准导入的账号字段为准。"""
    output = AccountOut.model_validate(account)
    if not include_credentials:
        output.game_password = None
    output.extra_values = extra_values or {}
    if source_order is not None:
        output.source_order_id = source_order.id
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
    extra_values = parties_service.get_extra_values_bulk(
        db, entity_type="account", entity_ids=[account.id for account in accounts]
    )
    return [
        _account_output(
            account,
            source_orders.get(account.id),
            include_credentials=include_credentials,
            extra_values=extra_values.get(account.id),
        )
        for account in accounts
    ]


@router.get("/stocks", response_model=AccountListOut)
def list_accounts(
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> AccountListOut:
    items = service.list_accounts(db, status=status, user=_user, limit=limit, offset=offset)
    return AccountListOut(
        items=_account_outputs(
            db,
            items,
            _user,
            include_credentials=_user.has(PERM_ORDER_CREATE),
        ),
        total=service.count_accounts(db, status=status, user=_user),
        limit=limit,
        offset=offset,
    )


@router.get("/stocks/export.csv")
def export_accounts_csv(
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> Response:
    """库存中心按可见列导出 CSV，沿用 /stocks 的权限口径。"""
    accounts = service.list_accounts(db, status=status, user=_user, limit=None, offset=0)
    outputs = _account_outputs(
        db,
        accounts,
        _user,
        include_credentials=_user.has(PERM_ORDER_CREATE),
    )
    csv_text, meta = build_list_csv(
        db, "INVENTORY", [output.model_dump() for output in outputs]
    )
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="INVENTORY",
        actor=_user.username,
        after={"rows": len(outputs), "column_count": meta["column_count"]},
    )
    return csv_file_response(csv_text, f"库存中心-{date.today().isoformat()}.csv")


@router.patch("/stocks/{account_id}", response_model=AccountOut)
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
    extras = parties_service.get_extra_values(db, entity_type="account", entity_id=item.id)
    return _account_output(item, include_credentials=True, extra_values=extras)


@router.get("/stocks/inventory", response_model=InventoryResponseOut)
def inventory(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> InventoryResponseOut:
    """库存健康表 R1：只统计在库与分期中的真实占用。"""
    rows = service.inventory(db, user=_user)
    total = sum((row["cost_amount"] for row in rows), Decimal("0"))
    return InventoryResponseOut(items=rows, count=len(rows), total_cost=total)


@router.get("/stocks/{account_id}/execution-detail", response_model=AccountExecutionDetailOut)
def execution_detail(
    account_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> AccountExecutionDetailOut:
    """查询库存账号关联的全部订单、已登记事件和资金流水。"""
    account = service.get_account(db, account_id, _user)
    order_stmt = select(Order).where(Order.account_id == account_id)
    order_scope = owner_scope_filter(Order.owner_id, _user, db)
    if order_scope is not None:
        order_stmt = order_stmt.where(order_scope)
    orders = list(db.scalars(order_stmt.order_by(Order.id)).all())
    order_ids = [item.id for item in orders]
    # 建单自定义字段写入订单 form_extra；parties_service 的扩展字段读取仅适用于客户实体。
    order_extra_values = {
        order.id: dict(order.form_extra or {})
        for order in orders
    }
    field_defs = list(db.scalars(select(OrderFormField).where(OrderFormField.order_type_code.in_({order.order_type for order in orders}), OrderFormField.is_active.is_(True))).all()) if orders else []
    field_defs_by_type = {}
    for definition in field_defs:
        field_defs_by_type.setdefault(definition.order_type_code, {})[definition.field_key] = definition
    counterparties_by_order: dict[int, list[ExecutionCounterpartyOut]] = {}
    customers_by_order: dict[int, list[ExecutionCustomerOut]] = {}
    if order_ids:
        for role, customer in db.execute(
            select(OrderCustomerRole, Customer)
            .join(Customer, Customer.id == OrderCustomerRole.customer_id)
            .where(OrderCustomerRole.order_id.in_(order_ids))
            .order_by(OrderCustomerRole.id)
        ).all():
            customers_by_order.setdefault(role.order_id, []).append(
                ExecutionCustomerOut(
                    id=customer.id,
                    display_name=customer.display_name,
                    role=role.role,
                )
            )
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
        for rebate in rebates:
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
    cashflows_by_order: dict[int, list[ExecutionCashflowOut]] = {}
    if order_ids:
        for flow, pool in db.execute(
            select(Cashflow, Pool)
            .join(Pool, Pool.id == Cashflow.pool_id)
            .where(
                Cashflow.order_id.in_(order_ids),
                Cashflow.order_event_id.is_(None),
            )
            .order_by(Cashflow.occurred_on, Cashflow.id)
        ).all():
            cashflows_by_order.setdefault(flow.order_id, []).append(
                ExecutionCashflowOut(
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
            )
    operator_ids = {uid for event in events for uid in (event.operator_user_ids or [])}
    operator_names = {user.id: user.display_name for user in db.scalars(select(User).where(User.id.in_(operator_ids))).all()} if operator_ids else {}
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
                pool_id=event.pool_id,
                offset_event_id=event.offset_event_id,
                portion=event.portion,
                delivery_mode=event.delivery_mode,
                is_posted=event.is_posted,
                reason=event.reason,
                note=event.note,
                cashflow=flow_by_event.get(event.id),
                operator=event.created_by,
                operator_user_ids=event.operator_user_ids,
                operator_names=[operator_names.get(uid, f"用户 {uid}") for uid in (event.operator_user_ids or [])],
            )
        )
    audit_rows: list[AccountAuditOut] = []
    if _user.has(PERM_AUDIT_READ):
        audit_filters = [
            (AuditLog.entity_type == "account") & (AuditLog.entity_id == str(account.id)),
        ]
        if order_ids:
            audit_filters.append((AuditLog.entity_type == "order") & AuditLog.entity_id.in_([order.order_no for order in orders]))
        if event_ids:
            audit_filters.append((AuditLog.entity_type == "inventory_event_edit") & AuditLog.entity_id.in_([str(event_id) for event_id in event_ids]))
        audit_rows = [
            AccountAuditOut(
                id=row.id,
                action=row.action,
                entity_type=row.entity_type,
                entity_id=row.entity_id,
                actor=row.actor,
                reason=row.reason,
                occurred_at=row.occurred_at,
            )
            for row in db.scalars(select(AuditLog).where(or_(*audit_filters)).order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())).all()
        ]
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
                account_platform=(order.account_snapshot or {}).get("platform"),
                note=order.note,
                extra_values=order_extra_values.get(order.id, {}),
                extra_fields=[
                    {"key": key, "label": field_defs_by_type.get(order.order_type, {}).get(key).label if field_defs_by_type.get(order.order_type, {}).get(key) else key,
                     "section": field_defs_by_type.get(order.order_type, {}).get(key).section if field_defs_by_type.get(order.order_type, {}).get(key) else "EXTRA",
                     "value": value}
                    for key, value in order_extra_values.get(order.id, {}).items()
                    if value not in (None, "", [])
                ],
                cashflows=cashflows_by_order.get(order.id, []),
                customers=customers_by_order.get(order.id, []),
                counterparties=counterparties_by_order.get(order.id, []),
                rebates=rebates_by_order.get(order.id, []),
                events=events_by_order.get(order.id, []),
                operator=order.created_by,
            )
            for order in orders
        ],
        audit=audit_rows,
    )


__all__ = ["router"]
