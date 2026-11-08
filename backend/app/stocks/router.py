"""accounts.router：账号台账 API（ACC-01）。

账号状态与成本由订单事件驱动，本模块**不提供**改状态/改成本入口（ACC-01-03/04）。
"""

from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.money import to_money
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
from app.domain.enums import AuditAction, EventType
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
from app.core.errors import Conflict, NotFound, PermissionDenied, Validation
from app.orders.amounts import order_profit_flow_by_order
# 复用订单台账「成交日期」的账期平移口径（事件/流水 occurred_on + 规则快照重取）。
from app.orders.mutations import _shift_accounting_dates
from ._common import scope_filter

from .schemas import (
    AccountOut,
    AccountListOut,
    AccountProfileUpdate,
    AccountDeleteRequest,
    ExecutionEditRequest,
    ExecutionTimeSet,
    InventoryResponseOut,
    InventoryStatsOut,
    InventoryStatsQuery,
    ExecutionCashflowOut,
    ExecutionEventOut,
    ExecutionCounterpartyOut,
    ExecutionCustomerOut,
    ExecutionRebateOut,
    AccountExecutionOrderOut,
    AccountAuditOut,
    AccountExecutionDetailOut,
    ExecutionFinanceSummaryOut,
)

router = APIRouter(tags=["ACC-01 账号台账"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
edit_execution = require_permissions(PERM_ORDER_UPDATE, PERM_FINANCE_ORDER_EVENT_POST)


def _parse_batch_ids(raw: str) -> list[int]:
    values = [part.strip() for part in raw.split(",") if part.strip()]
    if not values or len(values) > 500 or any(not part.isdigit() or int(part) <= 0 for part in values):
        raise Validation("ids 必须是 1-500 个正整数，逗号分隔")
    return list(dict.fromkeys(int(part) for part in values))


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


def _set_times(db: Session, account_id: int, time_set: ExecutionTimeSet, actor: str, user: CurrentUser) -> None:
    """账号台账三个系统时间戳绝对设值 / 清空（#15 需求2）。

    映射到账号来源单（与台账展示口径一致）：
    - registered_at → 来源单 Order.created_at
    - sold_at       → 来源单 SELL 事件 posted_at
    - flow_at       → 来源单首条资金流水 Cashflow.created_at
    仅 model_fields_set 中出现的字段生效；值为 None 表示清空（置 NULL）。
    """
    source_order = _source_orders(db, [account_id], user).get(account_id)
    if source_order is None:
        raise NotFound("账号关联来源订单不存在")
    changed: dict[str, object] = {}
    if "registered_at" in time_set.model_fields_set:
        source_order.created_at = time_set.registered_at
        source_order.updated_by = actor
        changed["registered_at"] = time_set.registered_at
    if "sold_at" in time_set.model_fields_set:
        sell = db.scalar(
            select(OrderEvent).where(
                OrderEvent.order_id == source_order.id,
                OrderEvent.event_type == "SELL",
                OrderEvent.is_posted.is_(True),
            ).order_by(OrderEvent.id)
        )
        if sell is None:
            raise NotFound("来源单没有已登记的售出事件，无法设置售出时间")
        sell.posted_at = time_set.sold_at
        sell.updated_by = actor
        changed["sold_at"] = time_set.sold_at
    if "flow_at" in time_set.model_fields_set:
        flow = db.scalar(
            select(Cashflow).where(Cashflow.order_id == source_order.id)
            .order_by(Cashflow.occurred_on, Cashflow.id)
        )
        if flow is None:
            raise NotFound("来源单没有资金流水，无法设置流水时间")
        flow.created_at = time_set.flow_at
        flow.updated_by = actor
        changed["flow_at"] = time_set.flow_at
    record_audit(
        db, action="ORDER_UPDATE", entity_type="inventory_time_set",
        entity_id=account_id, actor=actor,
        before={"mode": "absolute"},
        after={key: (value.isoformat() if value else None) for key, value in changed.items()},
    )


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
    event_ids = [item.id for item in payload.events]
    events_by_id = {
        event.id: event
        for event in db.scalars(
            select(OrderEvent)
            .where(OrderEvent.id.in_(event_ids))
            .with_for_update()
        ).all()
    } if event_ids else {}
    event_order_ids = {event.order_id for event in events_by_id.values()}
    order_stmt = select(Order).where(Order.id.in_(event_order_ids)) if event_order_ids else None
    if order_stmt is not None:
        order_scope = owner_scope_filter(Order.owner_id, user, db)
        if order_scope is not None:
            order_stmt = order_stmt.where(order_scope)
    orders_by_id = (
        {order.id: order for order in db.scalars(order_stmt).all()}
        if order_stmt is not None else {}
    )
    flows_by_event = {
        flow.order_event_id: flow
        for flow in db.scalars(
            select(Cashflow)
            .where(Cashflow.order_event_id.in_(event_ids))
            .with_for_update()
        ).all()
    } if event_ids else {}
    operator_ids = {
        operator_id
        for item in payload.events
        for operator_id in (item.operator_user_ids or [])
    }
    active_operator_ids = set(
        db.scalars(
            select(User.id).where(
                User.id.in_(operator_ids),
                User.is_active.is_(True),
            )
        ).all()
    ) if operator_ids else set()
    offset_event_ids = set(
        db.scalars(
            select(OrderEvent.offset_event_id).where(
                OrderEvent.offset_event_id.in_(event_ids)
            )
        ).all()
    ) if event_ids else set()
    flow_ids = [flow.id for flow in flows_by_event.values()]
    reversal_flow_ids = set(
        db.scalars(
            select(Cashflow.reversal_of_id).where(
                Cashflow.reversal_of_id.in_(flow_ids)
            )
        ).all()
    ) if flow_ids else set()
    order_ids = list(event_order_ids)
    installment_order_ids = set(
        db.scalars(
            select(Installment.order_id).where(Installment.order_id.in_(order_ids))
        ).all()
    ) if order_ids else set()
    rebate_order_ids = set(
        db.scalars(
            select(RebateRecord.source_order_id).where(
                RebateRecord.source_order_id.in_(order_ids)
            )
        ).all()
    ) if order_ids else set()
    reconciliation_dates_by_pool: dict[int, list[date]] = {}
    pool_ids = {flow.pool_id for flow in flows_by_event.values()}
    if pool_ids:
        for pool_id, reconciled_on in db.execute(
            select(Reconciliation.pool_id, Reconciliation.reconciled_on).where(
                Reconciliation.pool_id.in_(pool_ids)
            )
        ).all():
            reconciliation_dates_by_pool.setdefault(pool_id, []).append(reconciled_on)
    for item in payload.events:
        event = events_by_id.get(item.id)
        order = orders_by_id.get(event.order_id) if event else None
        if event is None or order is None or order.account_id != account_id or not event.is_posted:
            raise NotFound("执行记录不存在")
        if Decimal(str(event.amount)) != item.expected_amount:
            raise Conflict("执行记录已被修改，请刷新后重试")
        if item.operator_user_ids is not None:
            ids = item.operator_user_ids
            if len(set(ids)) != len(ids):
                raise Validation("操作人不能重复选择")
            if set(ids) - active_operator_ids:
                raise Validation("所选操作人不存在或已停用")
        flow = flows_by_event.get(event.id)
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
            or event.id in offset_event_ids
            or flow.id in reversal_flow_ids):
            raise Validation("已冲销或被冲销的记录不能直接修改")
        if order.id in installment_order_ids:
            raise Validation("关联分期的记录不能直接修改，请先处理分期")
        if order.id in rebate_order_ids:
            raise Validation("关联返点的记录不能直接修改，请先核对返点")
        if any(
            reconciled_on >= flow.occurred_on
            for reconciled_on in reconciliation_dates_by_pool.get(flow.pool_id, [])
        ):
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
        if "occurred_at" in item.model_fields_set:
            event.posted_at = item.occurred_at
        if flow is not None and "flow_occurred_at" in item.model_fields_set:
            flow.created_at = item.flow_occurred_at
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
    if payload.time_set is not None:
        _set_times(db, account_id, payload.time_set, user.username, user)
    elif payload.time_shift is not None:
        _apply_time_shift(db, account_id, payload.time_shift.delta_minutes, user.username)
    db.flush()
    return {"ok": True}


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
    inventory_operator: str | None = None,
) -> AccountOut:
    """统一补齐库存来源订单；业务与类型以标准导入的账号字段为准。"""
    output = AccountOut.model_validate(account)
    if not include_credentials:
        output.game_password = None
    output.extra_values = extra_values or {}
    if source_order is not None:
        output.source_order_id = source_order.id
        output.source_order_no = source_order.order_no
    # 入库负责人优先取建单表单中的业务负责人；没有选择时回退到实际登录账号。
    output.inventory_operator = inventory_operator or account.created_by
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
    responsible_ids = {
        int(item)
        for order in source_orders.values()
        for item in ((order.form_extra or {}).get("business_responsible_ids") or [])
        if isinstance(item, int) and item > 0
    }
    user_names = {
        item.id: item.display_name or item.username
        for item in db.scalars(select(User).where(User.id.in_(responsible_ids))).all()
    } if responsible_ids else {}
    extra_values = parties_service.get_extra_values_bulk(
        db, entity_type="account", entity_ids=[account.id for account in accounts]
    )
    return [
        _account_output(
            account,
            source_orders.get(account.id),
            include_credentials=include_credentials,
            extra_values=extra_values.get(account.id),
            inventory_operator=(
                "、".join(
                    user_names[item]
                    for item in ((source_orders.get(account.id).form_extra or {}).get("business_responsible_ids") or [])
                    if isinstance(item, int) and item in user_names
                )
                if source_orders.get(account.id) else None
            ),
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


def _require_admin(user: CurrentUser) -> None:
    """账号删除不可逆：权限收紧到系统管理员，operator/finance 即使有建单权也不可删。"""
    if not user.is_admin:
        raise PermissionDenied("仅系统管理员可删除账号")


@router.delete("/stocks/{account_id}", status_code=204, response_model=None)
def delete_account(
    account_id: int,
    payload: AccountDeleteRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> Response:
    """删除库存账号（仅管理员）。

    请求体必带删除原因（空白一律 422）；账号行物理删除，订单/事件/流水/返点
    全部保留并解绑，账号快照与原因写入审计日志，操作不可恢复。
    """
    _require_admin(user)
    service.delete_account(db, account_id, actor=_actor(user), reason=payload.reason, user=user)
    return Response(status_code=204)


@router.get("/stocks/inventory", response_model=InventoryResponseOut)
def inventory(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> InventoryResponseOut:
    """库存健康表 R1：只统计独立库存状态为在库的真实占用。"""
    rows = service.inventory(db, user=_user)
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
    stats = service.inventory_stats(db, account_ids=payload.account_ids, user=_user)
    return InventoryStatsOut(**stats)


@router.get("/stocks/execution-details", response_model=dict[int, AccountExecutionDetailOut])
def execution_details(
    ids: str = Query(..., description="库存账号 ID，逗号分隔"),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> dict[int, AccountExecutionDetailOut]:
    """批量读取库存账号详情：账号、订单、事件及流水统一批量加载。"""
    account_ids = _parse_batch_ids(ids)
    account_stmt = select(Account).where(Account.id.in_(account_ids))
    account_scope = scope_filter(db, _user)
    if account_scope is not None:
        account_stmt = account_stmt.where(account_scope)
    accounts_by_id = {
        account.id: account
        for account in db.scalars(account_stmt).all()
    }
    visible_accounts = [accounts_by_id[account_id] for account_id in account_ids if account_id in accounts_by_id]
    return _execution_details_for_accounts(db, visible_accounts, _user)


@router.get("/stocks/{account_id}/execution-detail", response_model=AccountExecutionDetailOut)
def execution_detail(
    account_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> AccountExecutionDetailOut:
    """查询库存账号关联的全部订单、已登记事件和资金流水。"""
    account = service.get_account(db, account_id, _user)
    return _execution_details_for_accounts(db, [account], _user)[account_id]


def _execution_details_for_accounts(
    db: Session,
    accounts: list[Account],
    user: CurrentUser,
) -> dict[int, AccountExecutionDetailOut]:
    """批量装配执行详情；所有跨账号关联数据只查询一次。"""
    if not accounts:
        return {}
    account_ids = [account.id for account in accounts]
    order_stmt = select(Order).where(Order.account_id.in_(account_ids))
    order_scope = owner_scope_filter(Order.owner_id, user, db)
    if order_scope is not None:
        order_stmt = order_stmt.where(order_scope)
    orders = list(db.scalars(order_stmt.order_by(Order.id)).all())
    orders_by_account: dict[int, list[Order]] = {}
    for order in orders:
        orders_by_account.setdefault(order.account_id, []).append(order)
    order_ids = [item.id for item in orders]
    order_account_ids = {order.id: order.account_id for order in orders}
    # 建单自定义字段写入订单 form_extra；parties_service 的扩展字段读取仅适用于客户实体。
    order_extra_values = {order.id: dict(order.form_extra or {}) for order in orders}
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
                    category=flow.category,
                    amount=flow.amount,
                    note=flow.note,
                    operator=flow.created_by,
                )
            )
    operator_ids = {uid for event in events for uid in (event.operator_user_ids or [])}
    operator_names = {user.id: user.display_name for user in db.scalars(select(User).where(User.id.in_(operator_ids))).all()} if operator_ids else {}
    # 可冲销余额：口径与 post_event 的校验同源（CANCEL 金额累加后从被冲销事件里扣），
    # 一次遍历算完，避免前端为了「还能冲多少」自己相减。
    cancelled_by_offset: dict[int, Decimal] = {}
    for item in events:
        if item.event_type == EventType.CANCEL.value and item.offset_event_id is not None:
            cancelled_by_offset[item.offset_event_id] = (
                cancelled_by_offset.get(item.offset_event_id, Decimal("0.00")) + to_money(item.amount)
            )
    events_by_order: dict[int, list[ExecutionEventOut]] = {}
    for event in events:
        cancellable = Decimal("0.00")
        if event.event_type != EventType.CANCEL.value:
            remaining = to_money(event.amount) - cancelled_by_offset.get(event.id, Decimal("0.00"))
            cancellable = remaining if remaining > 0 else Decimal("0.00")
        events_by_order.setdefault(event.order_id, []).append(
            ExecutionEventOut(
                id=event.id,
                event_no=event.event_no,
                event_type=event.event_type,
                amount=event.amount,
                cancellable_amount=cancellable,
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
    audit_by_account: dict[int, list[AccountAuditOut]] = {}
    if user.has(PERM_AUDIT_READ):
        audit_filters = [
            (AuditLog.entity_type == "account") & AuditLog.entity_id.in_([str(account_id) for account_id in account_ids]),
        ]
        if order_ids:
            audit_filters.append(
                (AuditLog.entity_type == "order")
                & AuditLog.entity_id.in_([order.order_no for order in orders])
            )
        if event_ids:
            audit_filters.append(
                (AuditLog.entity_type == "inventory_event_edit")
                & AuditLog.entity_id.in_([str(event_id) for event_id in event_ids])
            )
        audit_order_account_ids = {order.order_no: order.account_id for order in orders}
        event_account_ids = {
            event.id: order_account_ids.get(event.order_id)
            for event in events
        }
        for row in db.scalars(
            select(AuditLog)
            .where(or_(*audit_filters))
            .order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())
        ).all():
            if row.entity_type == "account":
                try:
                    account_for_audit = int(row.entity_id)
                except (TypeError, ValueError):
                    account_for_audit = None
            elif row.entity_type == "order":
                account_for_audit = audit_order_account_ids.get(row.entity_id)
            else:
                try:
                    account_for_audit = event_account_ids.get(int(row.entity_id))
                except (TypeError, ValueError):
                    account_for_audit = None
            if account_for_audit is None:
                continue
            audit_by_account.setdefault(account_for_audit, []).append(
                AccountAuditOut(
                    id=row.id,
                    action=row.action,
                    entity_type=row.entity_type,
                    entity_id=row.entity_id,
                    actor=row.actor,
                    reason=row.reason,
                    occurred_at=row.occurred_at,
                )
            )
    zero = Decimal("0.00")
    account_outputs = {
        output.id: output
        for output in _account_outputs(
            db,
            accounts,
            user,
            include_credentials=user.has(PERM_ORDER_CREATE),
        )
    }
    income_by_account: dict[int, Decimal] = {}
    expense_by_account: dict[int, Decimal] = {}
    rebate_by_account: dict[int, Decimal] = {}
    bad_debt_by_account: dict[int, Decimal] = {}
    for event_id, flow in flow_by_event.items():
        account_for_flow = order_account_ids.get(next((event.order_id for event in events if event.id == event_id), -1))
        if account_for_flow is None:
            continue
        target = income_by_account if flow.direction == "IN" else expense_by_account
        target[account_for_flow] = target.get(account_for_flow, zero) + flow.amount
    for order_id, flows in cashflows_by_order.items():
        account_for_flow = order_account_ids[order_id]
        for flow in flows:
            target = income_by_account if flow.direction == "IN" else expense_by_account
            target[account_for_flow] = target.get(account_for_flow, zero) + flow.amount
    for order_id, rebates in rebates_by_order.items():
        account_for_rebate = order_account_ids[order_id]
        rebate_by_account[account_for_rebate] = rebate_by_account.get(account_for_rebate, zero) + sum(
            (rebate.base_amount for rebate in rebates), zero
        )
    for order_id, (_rebate_income, expense) in order_profit_flow_by_order(
        db, order_ids=order_ids
    ).items():
        account_for_bad_debt = order_account_ids[order_id]
        bad_debt_by_account[account_for_bad_debt] = bad_debt_by_account.get(account_for_bad_debt, zero) + expense

    result: dict[int, AccountExecutionDetailOut] = {}
    for account in accounts:
        account_orders = orders_by_account.get(account.id, [])
        account_expense = expense_by_account.get(account.id, zero) + bad_debt_by_account.get(account.id, zero)
        result[account.id] = AccountExecutionDetailOut(
            account=account_outputs[account.id],
            finance_summary=ExecutionFinanceSummaryOut(
                cashflow_income=income_by_account.get(account.id, zero),
                rebate_income=rebate_by_account.get(account.id, zero),
                total_income=income_by_account.get(account.id, zero) + rebate_by_account.get(account.id, zero),
                total_expense=account_expense,
                net_amount=income_by_account.get(account.id, zero) + rebate_by_account.get(account.id, zero) - account_expense,
            ),
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
                        {
                            "key": key,
                            "label": field_defs_by_type.get(order.order_type, {}).get(key).label
                            if field_defs_by_type.get(order.order_type, {}).get(key)
                            else key,
                            "section": field_defs_by_type.get(order.order_type, {}).get(key).section
                            if field_defs_by_type.get(order.order_type, {}).get(key)
                            else "EXTRA",
                            "value": value,
                        }
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
                for order in account_orders
            ],
            audit=audit_by_account.get(account.id, []),
        )
    return result


__all__ = ["router"]
