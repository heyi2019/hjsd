"""accounts.router：账号台账 API（ACC-01）。

账号状态与成本由订单事件驱动，本模块**不提供**改状态/改成本入口（ACC-01-03/04）。
"""

from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
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
from app.lists.export import EXPORT_ROW_LIMIT, build_list_csv
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.stocks.inventory import (
    count_accounts,
    inventory as stocks_inventory,
    inventory_stats as stocks_inventory_stats,
    list_accounts as stocks_list_accounts,
)
from app.stocks.profile import (
    get_account,
    update_account_profile as stocks_update_account_profile,
)
from app.stocks.deletion import delete_inventory as stocks_delete_inventory
from app.parties.fields import get_extra_values
from app.domain.foundation import AuditLog
from app.domain.users import User
from app.domain.trade import (
    Account,
    Cashflow,
    Order,
    OrderEvent,
    Installment,
    Reconciliation,
)
from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, PermissionDenied, Validation
from app.orders._shared import get_order
# 复用订单台账「成交日期」的账期平移口径（事件/流水 occurred_on + 规则快照重取）。
from app.orders.mutations import _shift_accounting_dates

from .schemas import (
    AccountOut,
    AccountListOut,
    AccountProfileUpdate,
    AccountDeleteRequest,
    ExecutionEditRequest,
    InventoryResponseOut,
    InventoryStatsOut,
    InventoryStatsQuery,
    AccountExecutionOrderOut,
    AccountAuditOut,
    AccountExecutionDetailOut,
)

from .router_output import (
    _actor,
    _account_output,
    _account_outputs,
)
from .order_detail_view import build_detail_view
from .order_detail_view.assembler import build_order_outputs
from .order_detail_view.finance import build_finance_summary
from .order_detail_view.events import load_event_context
from .order_detail_view.relations import load_relations

router = APIRouter(tags=["ACC-01 账号台账"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
edit_execution = require_permissions(PERM_ORDER_UPDATE, PERM_FINANCE_ORDER_EVENT_POST)


def _apply_time_shift(db: Session, account_id: int, delta_minutes: int, actor: str) -> None:
    """账号台账时间联动：把该账号关联订单的整条时间轴平移 N 分钟。

    账期（trade_date / 事件与流水 occurred_on / 规则快照）走订单台账同源函数；
    台账界面展示的「登记时间」「售出时间」「流水时间」取的是 created_at / posted_at
    时间戳，必须一并平移，否则改完日期界面仍显示旧值。
    分期还款计划（first_due_on / 期次 due_on）按既定口径不动。
    """
    if delta_minutes == 0:
        return
    db.flush()  # 让同一请求内先前的执行记录改动对下面的查询可见
    shift = timedelta(minutes=delta_minutes)
    orders = list(db.scalars(select(Order).where(Order.account_id == account_id)).all())
    if not orders:
        raise NotFound("账号关联订单不存在")
    order_ids = [order.id for order in orders]
    events = list(db.scalars(select(OrderEvent).where(OrderEvent.order_id.in_(order_ids))).all())
    flows = list(db.scalars(select(Cashflow).where(Cashflow.order_id.in_(order_ids))).all())
    for order in orders:
        new_trade_date = order.trade_date + shift
        _shift_accounting_dates(db, order, actor=actor, new_trade_date=new_trade_date)
        order.trade_date = new_trade_date
        if order.created_at is not None:
            order.created_at = order.created_at + shift
        order.updated_by = actor
    for event in events:
        if event.posted_at is not None:
            event.posted_at = event.posted_at + shift
        if event.created_at is not None:
            event.created_at = event.created_at + shift
        event.updated_by = actor
    for flow in flows:
        if flow.created_at is not None:
            flow.created_at = flow.created_at + shift
        flow.updated_by = actor
    record_audit(
        db, action="ORDER_UPDATE", entity_type="inventory_time_shift",
        entity_id=account_id, actor=actor,
        before={"delta_minutes": 0},
        after={"delta_minutes": delta_minutes, "orders": len(orders), "events": len(events), "cashflows": len(flows)},
    )


@router.patch("/stocks/{account_id}/execution-edit")
def update_execution_detail(
    account_id: int, payload: ExecutionEditRequest,
    db: Session = Depends(get_db), user: CurrentUser = edit_execution,
) -> dict[str, bool]:
    account = get_account(db, account_id, user)
    db.scalar(select(Account).where(Account.id == account_id).with_for_update())
    if len({item.id for item in payload.events}) != len(payload.events):
        raise Validation("同一执行记录不能重复修改")
    changes = []
    cost_delta = Decimal("0")
    for item in payload.events:
        event = db.scalar(select(OrderEvent).where(OrderEvent.id == item.id).with_for_update())
        order = get_order(db, event.order_id, user) if event else None
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
        if event.event_type not in {"BUY", "SELL"} or item.amount <= 0:
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
        if event.event_type == "BUY":
            cost_delta += item.amount - Decimal(str(event.amount))
        changes.append((event, flow, item))
    if Decimal(str(account.cost_amount)) + cost_delta < 0:
        raise Validation("修改后库存成本不能为负数")
    if payload.profile is not None:
        account = stocks_update_account_profile(db, account_id, actor=user.username, user=user,
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
    if payload.time_shift is not None:
        _apply_time_shift(db, account_id, payload.time_shift.delta_minutes, user.username)
    db.flush()
    return {"ok": True}


@router.get("/stocks", response_model=AccountListOut)
def list_accounts(
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> AccountListOut:
    items = stocks_list_accounts(db, status=status, user=_user, limit=limit, offset=offset)
    return AccountListOut(
        items=_account_outputs(
            db,
            items,
            _user,
        ),
        total=count_accounts(db, status=status, user=_user),
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
    accounts = stocks_list_accounts(
        db, status=status, user=_user, limit=EXPORT_ROW_LIMIT, offset=0
    )
    outputs = _account_outputs(
        db,
        accounts,
        _user,
    )
    # 「未售时长」列的注册键是 inventory_age，而响应字段叫 inventory_age_days，
    # 不补别名整列会导出成空（列在、值没有）。格式与前端本地导出保持一致：`N天`。
    # 「状态」列（注册键 status）在界面上展示的是**库存状态**（在库/出库），
    # 不是库存周期状态（WAITING/SOLD/VOID）；不覆盖就会导出另一套值域的裸码。
    rows = [
        {
            **output.model_dump(),
            "status": output.inventory_status,
            "inventory_age": "" if output.inventory_age_days is None else f"{output.inventory_age_days}天",
        }
        for output in outputs
    ]
    csv_text, meta = build_list_csv(db, "INVENTORY", rows)
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="INVENTORY",
        actor=_user.username,
        after={
            "rows": meta["row_count"],
            "column_count": meta["column_count"],
            "truncated": meta["truncated"],
        },
    )
    return file_response(csv_text, f"库存中心-{date.today().isoformat()}.csv", CSV_MEDIA_TYPE)


@router.patch("/stocks/{account_id}", response_model=AccountOut)
def update_account_profile(
    account_id: int,
    payload: AccountProfileUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> AccountOut:
    get_account(db, account_id, user)
    changes = {
        field: getattr(payload, field)
        for field in payload.model_fields_set
    }
    item = stocks_update_account_profile(
        db, account_id, actor=_actor(user), user=user, **changes
    )
    extras = get_extra_values(db, entity_type="account", entity_id=item.id)
    return _account_output(item, extra_values=extras)


def _require_admin(user: CurrentUser) -> None:
    """删除不可逆：权限收紧到系统管理员，operator/finance 即使有建单权也不可删。"""
    if not user.is_admin:
        raise PermissionDenied("仅系统管理员可执行删除")


@router.delete("/stocks/{account_id}", status_code=204, response_model=None)
def delete_inventory(
    account_id: int,
    payload: AccountDeleteRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> Response:
    """删除及其全部订单从属数据（仅管理员）。

    请求体必带删除原因（空白一律 422）；库存及其订单/事件/流水/返点等从属数据
    全部物理删除，库存快照与原因写入审计日志，操作不可恢复。
    """
    _require_admin(user)
    stocks_delete_inventory(db, account_id, actor=_actor(user), reason=payload.reason, user=user)
    return Response(status_code=204)


@router.get("/stocks/inventory", response_model=InventoryResponseOut)
def inventory(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> InventoryResponseOut:
    """库存中心在库台账：只统计独立库存状态为在库的真实占用。"""
    rows = stocks_inventory(db, user=_user)
    total = sum((row["cost_amount"] for row in rows), Decimal("0"))
    return InventoryResponseOut(items=rows, count=len(rows), total_cost=total)


@router.post("/stocks/inventory/stats", response_model=InventoryStatsOut)
def inventory_stats(
    payload: InventoryStatsQuery,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> InventoryStatsOut:
    """汇总当前可见账号的占用成本与库龄档位。

    入参是界面此刻展示的账号集合，因此筛选口径只有一份（前端视图），
    金额累加与库龄天数只在后端算，前端不再做 float 求和。
    """
    stats = stocks_inventory_stats(db, account_ids=payload.account_ids, user=_user)
    return InventoryStatsOut(**stats)


@router.get("/stocks/{account_id}/execution-detail", response_model=AccountExecutionDetailOut)
def execution_detail(
    account_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
    order_id: int | None = None,
) -> AccountExecutionDetailOut:
    """查询库存账号关联的订单详情；传 order_id 时严格限定为当前订单。"""
    account = get_account(db, account_id, _user)
    order_stmt = select(Order).where(Order.account_id == account_id)
    if order_id is not None:
        order_stmt = order_stmt.where(Order.id == order_id)
    order_scope = owner_scope_filter(Order.owner_id, _user, db)
    if order_scope is not None:
        order_stmt = order_stmt.where(order_scope)
    orders = list(db.scalars(order_stmt.order_by(Order.id)).all())
    order_ids = [item.id for item in orders]
    relations = load_relations(db, orders)
    order_extra_values = relations.order_extra_values
    field_defs_by_type = relations.field_defs_by_type
    customers_by_order = relations.customers_by_order
    counterparties_by_order = relations.counterparties_by_order
    rebates_by_order = relations.rebates_by_order
    event_context = load_event_context(db, order_ids)
    events_by_order = event_context.events_by_order
    event_ids = [event.id for events in events_by_order.values() for event in events]
    flow_by_event = event_context.event_cashflows
    cashflows_by_order = event_context.order_cashflows
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
    finance_summary = build_finance_summary(
        db,
        order_ids=order_ids,
        event_cashflows=flow_by_event,
        order_cashflows=cashflows_by_order,
        order_rebates=rebates_by_order,
        action_model_rebate_ids=action_model_rebate_ids,
        deposit_loss_flow_nos=deposit_loss_flow_nos,
    )
    order_outputs = build_order_outputs(
        orders,
        order_extra_values=order_extra_values,
        field_defs_by_type=field_defs_by_type,
        cashflows_by_order=cashflows_by_order,
        customers_by_order=customers_by_order,
        counterparties_by_order=counterparties_by_order,
        rebates_by_order=rebates_by_order,
        events_by_order=events_by_order,
    )
    return AccountExecutionDetailOut(
        account=_account_outputs(
            db,
            [account],
            _user,
        )[0],
        finance_summary=finance_summary,
        orders=order_outputs,
        detail_view=build_detail_view(order_outputs),
        audit=audit_rows,
    )


@router.get("/orders/{order_id}/execution-detail", response_model=AccountExecutionDetailOut)
def order_execution_detail(
    order_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> AccountExecutionDetailOut:
    """查询单个订单的执行详情，财务/分润/操作明细均只属于该订单。"""
    order = get_order(db, order_id, _user)
    if order.account_id is None:
        raise NotFound("订单未关联库存账号")
    return execution_detail(
        account_id=order.account_id,
        db=db,
        _user=_user,
        order_id=order_id,
    )


__all__ = ["router"]
