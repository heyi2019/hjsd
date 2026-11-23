"""订单详情执行视图的读取与装配。"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import or_, select, tuple_
from sqlalchemy.orm import Session

from app.core.security import CurrentUser, PERM_AUDIT_READ, PERM_FINANCE_READ
from app.domain.foundation import AuditLog
from app.domain.trade import Account, Order
from app.domain.users import User
from app.shared.order_access import get_order
from app.shared.scope import owner_scope_filter
from app.shared.order_amounts import order_profit_flow_by_order
from app.business.inventory.profile import get_account
from app.business.inventory.router_output import _account_outputs
from app.business.inventory.schemas import AccountOut
from .execution_schemas import AccountAuditOut, AccountExecutionDetailOut

from .assembler import build_order_outputs
from .derived import build_detail_view
from .events import DetailEventContext, load_event_context
from .finance import build_finance_summary
from .relations import DetailRelations, load_relations


@dataclass(frozen=True)
class _ExportPreloaded:
    relations: DetailRelations
    context: DetailEventContext
    profit_flows: dict[int, tuple[Decimal, Decimal]]
    accounts: dict[int, AccountOut]
    audits: dict[int, list[AuditLog]]
    names: dict[int, str]


def load_order_execution_detail(
    db: Session, order_id: int, user: CurrentUser,
) -> AccountExecutionDetailOut:
    """读取一个订单及其强绑定账号的全部详情数据。"""
    order = get_order(db, order_id, user)
    if order.account_id is None:
        from app.core.errors import NotFound
        raise NotFound("订单未关联库存账号")
    account = get_account(db, order.account_id, user)
    return _assemble_order_execution_detail(db, order, account, user)


def _assemble_order_execution_detail(
    db: Session, order: Order, account: Account, user: CurrentUser, *,
    preloaded: _ExportPreloaded | None = None,
) -> AccountExecutionDetailOut:
    # get_order 已完成当前用户的 owner scope 校验；订单与账号是一一绑定关系，
    # 这里直接复用已加载的订单，避免为同一详情重复查订单。
    orders = [order]
    relations = preloaded.relations if preloaded is not None else load_relations(db, orders)
    context = preloaded.context if preloaded is not None else load_event_context(db, [order.id])
    all_events = context.events_by_order.get(order.id, [])
    def flow_visible(flow) -> bool:
        return flow is not None and user.has(PERM_FINANCE_READ) and flow.pool_id is not None and user.can_see_pool(flow.pool_id)

    events = {order.id: [event.model_copy(update={
        "cashflow": next((flow for flow in event.cashflows if flow_visible(flow)), None),
        "cashflows": [flow for flow in event.cashflows if flow_visible(flow)],
        "pool_id": event.pool_id if event.pool_id is None or (user.has(PERM_FINANCE_READ) and user.can_see_pool(event.pool_id)) else None,
    }) for event in all_events]}
    visible_cashflows = {order.id: [flow for flow in context.order_cashflows.get(order.id, []) if flow_visible(flow)]}
    visible_rebate_nos = {
        context.rebate_no_by_event_no[event.event_no]
        for event in all_events
        if event.event_no in context.rebate_no_by_event_no and any(flow_visible(flow) for flow in event.cashflows)
    }
    unrestricted = user.has(PERM_FINANCE_READ) and (user.is_admin or user.owner_scope == "ALL")
    visible_rebates = {order.id: [rebate for rebate in relations.rebates_by_order.get(order.id, [])
                                 if unrestricted or rebate.rebate_no in visible_rebate_nos]}
    rebate_nos = context.action_model_rebate_nos_by_order.get(order.id, set())
    event_ids = [event.id for rows in events.values() for event in rows]
    audit: list[AccountAuditOut] = []
    if user.has(PERM_AUDIT_READ):
        filters = [(AuditLog.entity_type == "account") & AuditLog.entity_id.in_([str(account.id), account.stock_no])]
        filters.append((AuditLog.entity_type == "order") & (AuditLog.entity_id == order.order_no))
        if event_ids:
            event_id_values = [str(item) for item in event_ids]
            filters.append((AuditLog.entity_type == "inventory_event_edit") & AuditLog.entity_id.in_(event_id_values))
        filters.append((AuditLog.entity_type == "inventory_order_edit") & AuditLog.entity_id.in_([str(order.id), order.order_no]))
        flow_nos = [flow.flow_no for flow in visible_cashflows[order.id]]
        if flow_nos:
            filters.append((AuditLog.entity_type == "inventory_cashflow_edit") & AuditLog.entity_id.in_(flow_nos))
        audit_rows = ([row for row in preloaded.audits.get(order.id, [])
                       if row.entity_type != "inventory_cashflow_edit" or row.entity_id in flow_nos]
                      if preloaded is not None else db.scalars(select(AuditLog).where(or_(*filters)).order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())).all())
        audit = [AccountAuditOut(id=row.id, action=row.action, entity_type=row.entity_type, entity_id=row.entity_id, actor=row.actor, reason=row.reason, occurred_at=row.occurred_at) for row in audit_rows]
    responsible_ids = {
        user_id
        for values in (relations.order_extra_values.get(order.id, {}),)
        for user_id in (values.get("business_responsible_ids") or [])
        if isinstance(user_id, int) and user_id > 0
    }
    names_by_id = preloaded.names if preloaded is not None else {
        user.id: user.display_name or user.username
        for user in db.scalars(select(User).where(User.id.in_(responsible_ids))).all()
    } if responsible_ids else {}
    outputs = build_order_outputs(
        orders,
        order_extra_values=relations.order_extra_values,
        field_defs_by_type=relations.field_defs_by_type,
        cashflows_by_order=visible_cashflows,
        customers_by_order=relations.customers_by_order,
        counterparties_by_order=relations.counterparties_by_order,
        rebates_by_order=visible_rebates,
        events_by_order=events,
        operator_names_by_order={
            order.id: [names_by_id[user_id] for user_id in (relations.order_extra_values.get(order.id, {}).get("business_responsible_ids") or []) if user_id in names_by_id]
            for order in orders
        },
    )
    return AccountExecutionDetailOut(
        account=preloaded.accounts[account.id] if preloaded is not None else _account_outputs(db, [account], user)[0],
        finance_summary=build_finance_summary(
            db,
            order_ids=[order.id],
            event_cashflows={flow.flow_no: flow for event in all_events
                             for flow in context.event_cashflows.get(event.event_no, [])},
            order_cashflows={order.id: context.order_cashflows.get(order.id, [])},
            order_rebates={order.id: relations.rebates_by_order.get(order.id, [])},
            action_model_rebate_nos=rebate_nos,
            deposit_loss_flow_nos=context.deposit_loss_flow_nos,
            profit_flows_by_order=preloaded.profit_flows if preloaded is not None else None,
        ),
        orders=outputs,
        detail_view=build_detail_view(
            outputs,
            account_description=account.account_description,
            account_images=account.account_images or [],
            action_model_rebate_nos=rebate_nos,
        ),
        audit=audit,
    )


def _visible_order_accounts(db: Session, order_ids: list[int], user: CurrentUser) -> dict[int, tuple[Order, Account]]:
    # 可见订单本身就是账号可见范围的依据，批量查询避免每条额外检查账号。
    stmt = select(Order, Account).join(Account, Account.id == Order.account_id).where(Order.id.in_(order_ids))
    scope = owner_scope_filter(Order.owner_id, user, db)
    if scope is not None:
        stmt = stmt.where(scope)
    return {order.id: (order, account) for order, account in db.execute(stmt).all()}


def load_order_execution_details_for_export(
    db: Session, order_ids: list[int], user: CurrentUser,
) -> list[AccountExecutionDetailOut | None]:
    """分块预取只读关系；失败时逐行回退，保留库存导出的错误隔离。"""
    if not order_ids:
        return []
    if len(order_ids) > 500:
        return [
            item
            for start in range(0, len(order_ids), 500)
            for item in load_order_execution_details_for_export(db, order_ids[start:start + 500], user)
        ]
    try:
        # 任一查询失败时只回滚保存点，不污染调用方事务。
        with db.begin_nested():
            visible: list[Order] = []
            accounts: list[Account] = []
            validated_rows: list[tuple[Order, Account] | None] = []
            pairs = _visible_order_accounts(db, order_ids, user)
            for order_id in order_ids:
                pair = pairs.get(order_id)
                validated_rows.append(pair)
                if pair is not None:
                    order, account = pair
                    visible.append(order)
                    accounts.append(account)
            ids = [order.id for order in visible]
            relations = load_relations(db, visible)
            context = load_event_context(db, ids)
            account_outputs = {
                account.id: output for account, output in zip(
                    accounts, _account_outputs(db, accounts, user, loaded_orders=visible), strict=True,
                )
            }
            responsible_ids = {
                uid for values in relations.order_extra_values.values()
                for uid in (values.get("business_responsible_ids") or [])
                if isinstance(uid, int) and uid > 0
            }
            names = {item.id: item.display_name or item.username for item in db.scalars(
                select(User).where(User.id.in_(responsible_ids))
            ).all()} if responsible_ids else {}
            audit_by_order = {}
            if user.has(PERM_AUDIT_READ):
                refs_by_order = {}
                for order, account in zip(visible, accounts, strict=True):
                    refs = {
                        ("account", str(account.id)), ("account", account.stock_no),
                        ("order", order.order_no), ("inventory_order_edit", str(order.id)),
                        ("inventory_order_edit", order.order_no),
                    }
                    refs.update(("inventory_event_edit", str(event.id)) for event in context.events_by_order.get(order.id, []))
                    refs.update(("inventory_cashflow_edit", flow.flow_no) for flow in context.order_cashflows.get(order.id, []))
                    refs_by_order[order.id] = refs
                refs = list(set().union(*refs_by_order.values())) if refs_by_order else []
                audit_by_ref = {}
                for start in range(0, len(refs), 5000):
                    query = select(AuditLog).where(
                        tuple_(AuditLog.entity_type, AuditLog.entity_id).in_(refs[start:start + 5000])
                    )
                    for row in db.scalars(query).all():
                        audit_by_ref.setdefault((row.entity_type, row.entity_id), []).append(row)
                for order_id, keys in refs_by_order.items():
                    rows = {row.id: row for key in keys for row in audit_by_ref.get(key, [])}
                    audit_by_order[order_id] = sorted(rows.values(), key=lambda row: (row.occurred_at, row.id), reverse=True)
            preloaded = _ExportPreloaded(
                relations, context, order_profit_flow_by_order(db, order_ids=ids),
                account_outputs, audit_by_order, names,
            )
            results = []
            for order_id, validated in zip(order_ids, validated_rows, strict=True):
                if validated is None:
                    results.append(None)
                    continue
                # 同一事件可有多笔流水，原单笔查询没有排序；回退以保留其选择行为。
                duplicates = context.duplicate_event_cashflow_sources
                use_batch = not any(event.event_no in duplicates for event in context.events_by_order.get(order_id, []))
                order, account = validated
                results.append(_assemble_order_execution_detail(
                    db, order, account, user, preloaded=preloaded if use_batch else None,
                ))
            return results
    except Exception:
        # 批量阶段异常只回退到原逐行读取；每行保存点隔离真实 SQL 错误。
        results = []
        for order_id in order_ids:
            try:
                with db.begin_nested():
                    detail = load_order_execution_detail(db, order_id, user)
                results.append(detail)
            except Exception:
                results.append(None)
        return results


# 跨域注册（P0-A 第三批）：库存台账导出的执行明细读取经注册点取用，
# stocks 不反向 import 本模块（合法方向只有 orders -> stocks）。
from app.business.inventory.collaboration import register_order_execution_loader, register_order_execution_batch_loader  # noqa: E402

register_order_execution_loader(load_order_execution_detail)
register_order_execution_batch_loader(load_order_execution_details_for_export)
