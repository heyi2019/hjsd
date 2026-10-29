"""reporting.service：R1 库存健康 / R2 月度经营损益 / R3 提成对账 / R5 业务级损益
+ 资金日报 / 订单利润明细（RPT-01）。

口径红线：
- 账号 COST 属直接成本，**不进运营费用**（R2 验收「作图费不会使运营费用重复增加」）。
- 未归集返点**独立成列，不摊给业务**（R5）。
- 回收与代挂账号纳入库存；提号只保留订单账号文本，不纳入库存（R1）。
"""
from __future__ import annotations

from collections import defaultdict
import csv
import io
import json
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AccountStatus,
    CashflowStatus,
    Direction,
    EventType,
    InstallmentDispositionAction,
    Nature,
    OrderStatus,
)
from app.domain.foundation import Pool
from app.domain.trade import (
    Account,
    Cashflow,
    Deposit,
    Order,
    OrderEvent,
    OrderProfitAllocation,
    Installment,
    InstallmentDisposition,
    RebateRecord,
    RebateSettlement,
)
from app.parties import service as parties_service
from app.foundation.classification import classification_for_order_type
from app.orders.amounts import (
    event_contribution as order_event_contribution,
    event_totals as order_event_totals,
)

ZERO = Decimal("0")
REPORT_NAMES = frozenset(
    {
        "inventory-health",
        "monthly-pnl",
        "commission",
        "business-pnl",
        "daily-funds",
        "order-profit",
        "finance-dimensions",
    }
)


def _validate_date_range(
    from_date: date | None, to_date: date | None
) -> None:
    if from_date is not None and to_date is not None and from_date > to_date:
        raise Validation(
            "开始日期不能晚于结束日期",
            details={"from": from_date.isoformat(), "to": to_date.isoformat()},
        )


def report_for_export(
    session: Session,
    report_name: str,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    on: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """统一执行可导出的报表，所有分支复用既有数据权限和口径。"""
    name = report_name.strip().lower()
    if name not in REPORT_NAMES:
        raise Validation(
            "不支持导出的报表",
            details={"report_name": report_name, "allowed": sorted(REPORT_NAMES)},
        )
    if name == "inventory-health":
        return r1_inventory_health(session, user=user)
    if name == "monthly-pnl":
        return r2_monthly_pnl(session, from_date=from_date, to_date=to_date, user=user)
    if name == "commission":
        return r3_commission_reconciliation(
            session, from_date=from_date, to_date=to_date, user=user
        )
    if name == "business-pnl":
        return r5_business_pnl(session, from_date=from_date, to_date=to_date, user=user)
    if name == "finance-dimensions":
        return finance_dimension_report(session, from_date=from_date, to_date=to_date, user=user)
    if name == "daily-funds":
        return daily_funds_report(session, on=on, user=user)
    return order_profit_detail(session, from_date=from_date, to_date=to_date, user=user)


def report_csv(
    report: dict[str, Any],
    *,
    columns: list[tuple[str, str, bool]] | None = None,
    value_labels: dict[str, dict[str, str]] | None = None,
) -> str:
    """将报表 items 与 total 统一导出为 UTF-8 CSV，嵌套字段保留为 JSON。

    `columns` = 该报表对应列表作用域的**全部登记列** [(字段键, 中文表头, 是否可见)]：
    - 只导可见列，顺序按配置顺序，表头用中文（与界面列名一致）；
    - 「已登记但被隐藏」的列一律剔除 —— 界面看不到的列不该出现在导出的表里；
    - 明细行里**未登记**的键一律不导（order_id / pool_id / extra_values 这类内部字段
      此前会被当成新列追加出去，导出表因此很脏）；
    - 唯一例外：**合计行独有**的未登记键（如 total_amount），追加在末尾，避免合计丢失。
      注意必须传全量配置而非只传可见列，否则隐藏列会被误判成「未登记」；
    - 传 None 时退回「数据里出现什么键就导什么列」的旧行为。

    `value_labels` = {列 key: {代码值: 中文}}，来自 lists.get_value_labels()：
    - 只翻译「字符串且命中字典」的单元格；金额 / 日期 / 未命中值原样输出；
    - row_type 是导出专用的机器标记（ITEM / TOTAL），不属于任何字典，保持英文，
      既有报表回归按它区分明细与合计；
    - 传 None 时所有值保留原样（旧行为）。
    """
    items = report.get("items") if isinstance(report.get("items"), list) else []
    total = report.get("total") if isinstance(report.get("total"), dict) else None
    rows: list[dict[str, Any]] = [
        {"row_type": "ITEM", **item} for item in items if isinstance(item, dict)
    ]
    if total is not None:
        rows.append({"row_type": "TOTAL", **total})
    keys: list[str] = ["row_type"]
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    if len(keys) == 1:
        keys.extend(["items", "total"])
    item_keys: set[str] = {
        key for item in items if isinstance(item, dict) for key in item
    }
    # 只认「合计行独有」的键：明细里也出现过的未登记字段（如 buy_amount）不算，
    # 否则界面没登记的明细字段会从合计行漏回导出表。
    total_only_keys: list[str] = [
        key for key in (total.keys() if total is not None else ()) if key not in item_keys
    ]

    if columns is None:
        fieldnames = list(keys)
        header = list(keys)
    else:
        labels = {key: label for key, label, _visible in columns}
        registered = {key for key, _label, _visible in columns}
        fieldnames = ["row_type"]
        for key, _label, visible in columns:
            if visible and key != "row_type" and key in keys and key not in fieldnames:
                fieldnames.append(key)
        # 只补合计行独有的字段：明细里的 order_id / extra_values 等内部字段不导
        for key in total_only_keys:
            if key not in fieldnames and key not in registered:
                fieldnames.append(key)
        header = ["row_type" if key == "row_type" else labels.get(key, key) for key in fieldnames]

    def normalize(value: Any) -> Any:
        if value is None:
            return ""
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False, default=str)
        return value

    def cell(key: str, value: Any) -> Any:
        mapping = value_labels.get(key) if value_labels else None
        if mapping and isinstance(value, str) and value in mapping:
            return mapping[value]
        return normalize(value)

    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=fieldnames,
        extrasaction="ignore",
        lineterminator="\r\n",
    )
    # 表头手工写：fieldnames 是字段键（取值用），首行要中文
    writer.writerow(dict(zip(fieldnames, header)))
    for row in rows:
        writer.writerow({key: cell(key, row.get(key)) for key in fieldnames})
    return "\ufeff" + stream.getvalue()


def finance_dimension_report(
    session: Session,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """按资金性质、核算属性、方向和账户聚合已审核流水。"""
    _validate_date_range(from_date, to_date)
    stmt = (
        select(
            Pool.id.label("pool_id"),
            Pool.code.label("pool_code"),
            Pool.name.label("pool_name"),
            Cashflow.fund_nature,
            Cashflow.accounting_attribute,
            Cashflow.direction,
            func.count(Cashflow.id).label("flow_count"),
            func.sum(Cashflow.amount).label("amount"),
            func.sum(
                case(
                    (Cashflow.direction == Direction.IN.value, Cashflow.amount),
                    else_=-Cashflow.amount,
                )
            ).label("signed_amount"),
        )
        .join(Pool, Pool.id == Cashflow.pool_id)
        .where(Cashflow.status == CashflowStatus.APPROVED.value)
        .group_by(
            Pool.id, Pool.code, Pool.name,
            Cashflow.fund_nature,
            Cashflow.accounting_attribute, Cashflow.direction,
        )
        .order_by(Pool.code, Cashflow.fund_nature, Cashflow.accounting_attribute, Cashflow.direction)
    )
    if from_date is not None:
        stmt = stmt.where(Cashflow.occurred_on >= from_date)
    if to_date is not None:
        stmt = stmt.where(Cashflow.occurred_on <= to_date)
    visible_pool_ids = _visible_pool_ids(user)
    if visible_pool_ids is not None:
        stmt = stmt.where(Cashflow.pool_id.in_(visible_pool_ids))
    rows = session.execute(stmt).mappings().all()
    items = [
        {
            "pool_id": row["pool_id"],
            "pool_code": row["pool_code"],
            "pool_name": row["pool_name"],
            "fund_nature": row["fund_nature"],
            "accounting_attribute": row["accounting_attribute"],
            "direction": row["direction"],
            "flow_count": int(row["flow_count"] or 0),
            "amount": _money(row["amount"]),
            "signed_amount": _money(row["signed_amount"]),
        }
        for row in rows
    ]
    return {
        "from_date": from_date.isoformat() if from_date else None,
        "to_date": to_date.isoformat() if to_date else None,
        "items": items,
        "total_amount": _sum_report_field(items, "amount"),
        "total_signed_amount": _sum_report_field(items, "signed_amount"),
    }


def _sum_report_field(items: list[dict[str, Any]], field: str) -> Decimal:
    return sum((item[field] for item in items), ZERO)


def _money(value: Any) -> Decimal:
    return to_money(value or 0)


def _event_contribution(
    event: OrderEvent, event_types: dict[int, str]
) -> tuple[Decimal, Decimal, Decimal]:
    """单个事件的 (income, buy_amount, direct_cost)。

    实现已下沉到 app/orders/amounts.py：报表与规则派生（返点基数 / 分期服务费基数）
    必须共用同一口径，避免复制后漂移。保留本名以兼容既有测试与内部调用。
    """
    return order_event_contribution(event, event_types)


def _event_totals(
    events: list[OrderEvent], *, from_date: date | None = None, to_date: date | None = None
) -> tuple[Decimal, Decimal, Decimal]:
    """事件汇总；实现见 app/orders/amounts.py。"""
    return order_event_totals(events, from_date=from_date, to_date=to_date)


def _bad_debt_rows(
    session: Session,
    *,
    user: CurrentUser | None = None,
) -> list[tuple[int, Decimal, date]]:
    """Return (order_id, recognized_loss, recognized_on) for recovered contracts."""
    stmt = (
        select(
            Installment.order_id,
            Installment.bad_debt_amount,
            InstallmentDisposition.occurred_on,
        )
        .join(
            InstallmentDisposition,
            InstallmentDisposition.installment_id == Installment.id,
        )
        .join(Order, Order.id == Installment.order_id)
        .where(
            InstallmentDisposition.action == InstallmentDispositionAction.RECOVER.value,
            Installment.bad_debt_amount > 0,
        )
    )
    stmt = _apply_order_scope(stmt, user, session)
    return [
        (order_id, _money(amount), occurred_on)
        for order_id, amount, occurred_on in session.execute(stmt).all()
    ]


def _bad_debt_by_order(
    session: Session,
    *,
    user: CurrentUser | None = None,
) -> dict[int, Decimal]:
    totals: dict[int, Decimal] = defaultdict(lambda: ZERO)
    for order_id, amount, _occurred_on in _bad_debt_rows(session, user=user):
        totals[order_id] += amount
    return totals


def _month_key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _apply_order_scope(stmt, user: CurrentUser | None, session: Session):
    if user is None:
        return stmt
    scope = owner_scope_filter(Order.owner_id, user, session)
    return stmt.where(scope) if scope is not None else stmt


def _visible_pool_ids(user: CurrentUser | None) -> set[int] | None:
    if user is None or user.is_admin or user.owner_scope == "ALL":
        return None
    return set(user.pool_ids)


# --------------------------------------------------------------------- R1 库存
def r1_inventory_health(
    session: Session, *, user: CurrentUser | None = None
) -> dict[str, Any]:
    """R1 库存健康表：统计回收/代挂账号中处于在库或分期状态的账号。"""
    today = date.today()
    stock_statuses = [
        AccountStatus.IN_STOCK.value,
        AccountStatus.INSTALLMENT.value,
    ]

    order_cost: dict[int, Decimal] = defaultdict(lambda: ZERO)
    order_income: dict[int, Decimal] = defaultdict(lambda: ZERO)
    event_rows = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    for event in event_rows:
        events_by_order[event.order_id].append(event)
    for order_id, events in events_by_order.items():
        income, buy_amount, direct_cost = _event_totals(events)
        order_income[order_id] = income
        order_cost[order_id] = buy_amount + direct_cost

    active_stmt = select(Order).where(Order.status == OrderStatus.ACTIVE.value)
    active_stmt = _apply_order_scope(active_stmt, user, session)
    active = session.scalars(active_stmt).all()
    order_by_account: dict[int, list[Order]] = defaultdict(list)
    for order in active:
        if order.account_id is not None:
            order_by_account[order.account_id].append(order)

    items = []
    account_stmt = select(Account)
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        visible_order_ids = select(Order.account_id).where(Order.account_id.is_not(None))
        visible_order_ids = _apply_order_scope(visible_order_ids, user, session)
        account_stmt = account_stmt.where(
            (Account.created_by == user.username) | Account.id.in_(visible_order_ids)
        )
    accounts = session.scalars(account_stmt).all()
    account_extra_values = parties_service.get_extra_values_bulk(
        session,
        entity_type="account",
        entity_ids=[account.id for account in accounts],
    )
    for account in accounts:
        if account.inventory_type == "PICKUP":
            continue
        if account.status not in stock_statuses:
            continue
        orders = order_by_account.get(account.id, [])
        holding_days = (
            (today - account.buy_date).days if account.buy_date else None
        )
        expected_price = ZERO
        for order in orders:
            expected_price += order_income[order.id]
        total_cost = _money(account.cost_amount)
        items.append(
            {
                "account_id": account.id,
                "game_account": account.game_account,
                "platform": account.platform,
                "business": ",".join({o.order_type for o in orders}) or None,
                "status": account.status,
                "buy_amount": total_cost,
                "extra_cost": max(
                    ZERO, sum((order_cost[o.id] for o in orders), ZERO) - total_cost
                ),
                "total_cost": total_cost,
                "holding_days": holding_days,
                "expected_price": expected_price,
                "expected_profit": expected_price - total_cost,
                "owner_id": orders[0].owner_id if orders else None,
                "extra_values": account_extra_values.get(account.id, {}),
            }
        )
    return {
        "generated_on": today.isoformat(),
        "items": items,
        "total": len(items),
        "total_cost": sum((item["total_cost"] for item in items), ZERO),
    }


# --------------------------------------------------------------------- R2 月度
def r2_monthly_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R2 月度经营损益：账号 COST 归直接成本，不进运营费用。"""
    _validate_date_range(from_date, to_date)
    events = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    direct_cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    event_types = {event.id: event.event_type for event in events}
    for event in events:
        if from_date and event.occurred_on < from_date:
            continue
        if to_date and event.occurred_on > to_date:
            continue
        key = _month_key(event.occurred_on)
        income, buy_amount, event_cost = _event_contribution(event, event_types)
        revenue[key] += income
        direct_cost[key] += buy_amount + event_cost

    for _order_id, amount, occurred_on in _bad_debt_rows(session, user=user):
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        direct_cost[_month_key(occurred_on)] += amount

    # 运营费用只认资金属性，避免依赖自由填写的流水类别。
    op_stmt = select(Cashflow).where(
        Cashflow.status == CashflowStatus.APPROVED.value,
        Cashflow.order_event_id.is_(None),
        or_(Cashflow.fund_nature == "BUSINESS", Cashflow.category == "OPERATING_COST"),
        or_(
            Cashflow.accounting_attribute == "OPERATING_EXPENSE",
            Cashflow.accounting_attribute == "REVERSAL",
            Cashflow.category == "OPERATING_COST",
        ),
    )
    pool_ids = _visible_pool_ids(user)
    if pool_ids is not None:
        op_stmt = op_stmt.where(Cashflow.pool_id.in_(pool_ids))
    op_rows = session.scalars(op_stmt).all()
    operating: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for flow in op_rows:
        occurred_on = flow.occurred_on
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        amount = _money(flow.amount)
        if (
            flow.direction == Direction.OUT.value
            and flow.nature == Nature.BUSINESS_OUT.value
        ):
            operating[_month_key(occurred_on)] += amount
        elif flow.reversal_of_id is not None:
            original = session.get(Cashflow, flow.reversal_of_id)
            if original is not None and (
                original.direction == Direction.OUT.value
                and original.nature == Nature.BUSINESS_OUT.value
            ):
                operating[_month_key(occurred_on)] -= amount

    rebate_stmt = (
        select(
            RebateSettlement.settled_on,
            RebateSettlement.gross_amount,
            RebateSettlement.platform_fee,
            RebateSettlement.reversal_of_id,
        )
        .join(RebateRecord, RebateRecord.id == RebateSettlement.rebate_record_id)
        .join(Order, Order.id == RebateRecord.source_order_id)
    )
    rebate_stmt = _apply_order_scope(rebate_stmt, user, session)
    rebate_rows = session.execute(rebate_stmt).all()
    rebate_income: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for settled_on, gross, fee, reversal_of_id in rebate_rows:
        if from_date and settled_on < from_date:
            continue
        if to_date and settled_on > to_date:
            continue
        sign = Decimal("-1") if reversal_of_id is not None else Decimal("1")
        rebate_income[_month_key(settled_on)] += sign * _money(gross)

    for bucket in (revenue, direct_cost, operating, rebate_income):
        for month in list(bucket):
            if bucket[month] == ZERO:
                del bucket[month]
    months = sorted(set(revenue) | set(direct_cost) | set(operating) | set(rebate_income))
    items = []
    for month in months:
        income = revenue[month]
        cost = direct_cost[month]
        op = operating[month]
        rebate = rebate_income[month]
        items.append(
            {
                "month": month,
                "sales_income": income,
                "account_direct_cost": cost,
                "operating_expense": op,
                "rebate_income": rebate,
                "operating_profit": income - cost - op + rebate,
            }
        )
    return {
        "items": items,
        "total": {
            "sales_income": _sum_report_field(items, "sales_income"),
            "account_direct_cost": _sum_report_field(items, "account_direct_cost"),
            "operating_expense": _sum_report_field(items, "operating_expense"),
            "rebate_income": _sum_report_field(items, "rebate_income"),
            "operating_profit": _sum_report_field(items, "operating_profit"),
        },
    }


# --------------------------------------------------------------------- R3 提成
def r3_commission_reconciliation(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R3 提成对账：按人员钻取到单；无规则版本时提成率为 0（不臆造）。"""
    _validate_date_range(from_date, to_date)
    rows = session.execute(
        _apply_order_scope(
            select(OrderProfitAllocation, Order)
            .join(Order, Order.id == OrderProfitAllocation.order_id)
            .where(Order.status.in_([OrderStatus.COMPLETED.value, OrderStatus.ACTIVE.value])),
            user,
            session,
        )
    ).all()

    per_order_profit: dict[int, Decimal] = defaultdict(lambda: ZERO)
    events = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    for event in events:
        events_by_order[event.order_id].append(event)
    for order_id, order_events in events_by_order.items():
        income, buy_amount, direct_cost = _event_totals(order_events)
        per_order_profit[order_id] = income - buy_amount - direct_cost
    for order_id, amount in _bad_debt_by_order(session, user=user).items():
        per_order_profit[order_id] -= amount

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for allocation, order in rows:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        profit = per_order_profit[order.id]
        rate = _money(allocation.allocation_rate)
        amount = _money(allocation.allocation_amount)
        # 分润支持「按比例」与「按金额」两种录入口径：填了金额就直接作为应付基数，
        # 否则按 利润 × 比例 计算。二者由录入校验保证不会同时出现。
        base = (
            amount
            if amount > 0
            else (profit * rate / Decimal("100")).quantize(Decimal("0.01"))
        )
        grouped[allocation.user_id].append(
            {
                "user_id": allocation.user_id,
                "order_no": order.order_no,
                "order_id": order.id,
                "allocation_type": allocation.allocation_type,
                "profit_base": base,
                "rate": allocation.allocation_rate,
                "amount": allocation.allocation_amount,
                "payable": ZERO,
                "paid": ZERO,
                "difference": ZERO,
            }
        )

    groups = []
    items = []
    for user_id, orders in sorted(grouped.items(), key=lambda item: item[0] or 0):
        base_total = sum((o["profit_base"] for o in orders), ZERO)
        group = {
            "user_id": user_id,
            "order_count": len(orders),
            "profit_base": base_total,
            "payable": sum((o["payable"] for o in orders), ZERO),
            "paid": sum((o["paid"] for o in orders), ZERO),
            "difference": sum((o["difference"] for o in orders), ZERO),
            "orders": orders,
        }
        groups.append(group)
        items.extend(orders)
    return {
        "items": items,
        "groups": groups,
        "total": {
            "order_count": len(items),
            "payable": _sum_report_field(items, "payable"),
            "paid": _sum_report_field(items, "paid"),
            "difference": _sum_report_field(items, "difference"),
        },
    }


# --------------------------------------------------------------------- R5 业务
def _event_gain_cases(amount):
    """事件损益的三个条件求和分支（income / buy / cost）。

    口径与 order_event_totals 一致：SELL=收入 / BUY=买入成本 / COST=直接费用；
    CANCEL 仅当显式 offset 且被冲销事件与本单同单时才冲销（跨单 offset 视同
    无冲销——同单约束由外连接的 ON 条件保证，与 Python 侧按本单事件表解析
    offset 类型行为一致）。
    """
    offset = aliased(OrderEvent)
    return offset, [
        case(
            (OrderEvent.event_type == EventType.SELL.value, amount),
            (and_(
                OrderEvent.event_type == EventType.CANCEL.value,
                offset.event_type == EventType.SELL.value,
            ), -amount),
            else_=0,
        ),
        case(
            (OrderEvent.event_type == EventType.BUY.value, amount),
            (and_(
                OrderEvent.event_type == EventType.CANCEL.value,
                offset.event_type == EventType.BUY.value,
            ), -amount),
            else_=0,
        ),
        case(
            (OrderEvent.event_type == EventType.COST.value, amount),
            (and_(
                OrderEvent.event_type == EventType.CANCEL.value,
                offset.event_type == EventType.COST.value,
            ), -amount),
            else_=0,
        ),
    ]


def _event_offset_join(offset):
    return and_(
        offset.id == OrderEvent.offset_event_id,
        offset.order_id == OrderEvent.order_id,
    )


def r5_business_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R5 业务级损益：未归集返点独立列，不摊给业务。

    2026-10-28 性能改造：损益事件按「订单×业务」在 SQL 端条件求和（仍按单
    聚合后再归业务，保证 order_types 语义不变），返点结算改为列级查询 +
    条件求和；不再把全部订单×事件 ORM 水合进内存。返回口径与旧实现一致。
    """
    _validate_date_range(from_date, to_date)
    offset, (income_case, buy_case, cost_case) = _event_gain_cases(OrderEvent.amount)
    event_agg = (
        select(
            Order.id.label("order_id"),
            Order.order_type,
            func.coalesce(func.sum(income_case), 0).label("income"),
            func.coalesce(func.sum(buy_case), 0).label("buy_amount"),
            func.coalesce(func.sum(cost_case), 0).label("direct_cost"),
        )
        .join(OrderEvent, OrderEvent.order_id == Order.id)
        .outerjoin(offset, _event_offset_join(offset))
        .where(OrderEvent.is_posted.is_(True))
        .group_by(Order.id, Order.order_type)
    )
    if from_date is not None:
        event_agg = event_agg.where(OrderEvent.occurred_on >= from_date)
    if to_date is not None:
        event_agg = event_agg.where(OrderEvent.occurred_on <= to_date)
    event_agg = _apply_order_scope(event_agg, user, session)

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    order_types: dict[int, str] = {}
    for order_id, order_type, income, buy_amount, direct_cost in session.execute(
        event_agg
    ).all():
        revenue[order_type] += _money(income)
        cost[order_type] += _money(buy_amount) + _money(direct_cost)
        order_types[order_id] = order_type

    for order_id, amount, occurred_on in _bad_debt_rows(session, user=user):
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        order_type = order_types.get(order_id)
        if order_type is not None:
            cost[order_type] += amount

    settled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    unsettled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    # 分次结算按返点记录聚合：冲销（reversal_of_id 非空）取负号；日期过滤
    # 放进外连接 ON 条件——范围外的结算视同不存在，与旧 Python 过滤一致。
    settlement_join = [RebateSettlement.rebate_record_id == RebateRecord.id]
    if from_date is not None:
        settlement_join.append(RebateSettlement.settled_on >= from_date)
    if to_date is not None:
        settlement_join.append(RebateSettlement.settled_on <= to_date)
    rebate_stmt = (
        select(
            RebateRecord.id,
            RebateRecord.base_amount,
            RebateRecord.rate,
            Order.order_type,
            func.coalesce(
                func.sum(
                    case(
                        (RebateSettlement.reversal_of_id.isnot(None), -RebateSettlement.gross_amount),
                        else_=RebateSettlement.gross_amount,
                    )
                ),
                0,
            ).label("settled_gross"),
            func.coalesce(
                func.sum(
                    case(
                        (RebateSettlement.reversal_of_id.isnot(None), -RebateSettlement.platform_fee),
                        else_=RebateSettlement.platform_fee,
                    )
                ),
                0,
            ).label("settled_fee"),
        )
        .outerjoin(RebateSettlement, and_(*settlement_join))
        .join(Order, Order.id == RebateRecord.source_order_id)
        .group_by(RebateRecord.id, Order.order_type)
    )
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            rebate_stmt = rebate_stmt.where(
                scope,
            )
    for _record_id, base_amount, rate, order_type, settled_gross, settled_fee in (
        session.execute(rebate_stmt).all()
    ):
        bucket = order_type
        settled_gross = _money(settled_gross)
        settled[bucket] += settled_gross
        cost[bucket] += _money(settled_fee)
        expected = (
            _money(base_amount) * _money(rate) / Decimal("100")
        ).quantize(Decimal("0.01"))
        # 分次结算只减少剩余未归集金额；没有结算记录时即为全部应收返点。
        unsettled[bucket] += max(ZERO, expected - settled_gross)

    items = []
    for order_type in sorted(set(revenue) | set(cost) | set(settled) | set(unsettled)):
        income = revenue[order_type]
        direct = cost[order_type]
        gross_profit = income - direct
        classification = classification_for_order_type(order_type) or {
            "business_mode": None,
            "business_type": None,
            "value_added_service": None,
        }
        items.append(
            {
                "order_type": order_type,
                **classification,
                "main_income": income,
                "main_cost": direct,
                "main_profit": gross_profit,
                "settled_rebate": settled[order_type],
                "uncollected_rebate": unsettled[order_type],
                "full_income": gross_profit + settled[order_type],
            }
        )
    return {
        "items": items,
        "total": {
            "main_income": _sum_report_field(items, "main_income"),
            "main_cost": _sum_report_field(items, "main_cost"),
            "main_profit": _sum_report_field(items, "main_profit"),
            "settled_rebate": _sum_report_field(items, "settled_rebate"),
            "uncollected_rebate": _sum_report_field(items, "uncollected_rebate"),
            "full_income": _sum_report_field(items, "full_income"),
        },
    }


# --------------------------------------------------------------------- 资金日报
def daily_funds_report(
    session: Session, *, on: date | None = None, user: CurrentUser | None = None
) -> dict[str, Any]:
    """资金日报：各池期初、经营收支、内部划转、押金与可用余额。"""
    from app.orders.service import pool_balances

    target = on or date.today()
    pool_stmt = select(Pool)
    visible = _visible_pool_ids(user)
    if visible is not None:
        pool_stmt = pool_stmt.where(Pool.id.in_(visible))
    pools = session.scalars(pool_stmt).all()
    ids = [pool.id for pool in pools]

    # 逐池标量查询改为一次分组聚合：期初按池累计有符号和，当日按 (方向, 性质) 分箱。
    opening_by_pool: dict[int, Decimal] = {}
    day_cells: dict[int, dict[tuple[str, str], Decimal]] = {}
    deposit_paid_by_pool: dict[int, Decimal] = {}
    if ids:
        for pool_id, amount in session.execute(
            select(
                Cashflow.pool_id,
                func.coalesce(
                    func.sum(
                        case(
                            (Cashflow.direction == Direction.IN.value, Cashflow.amount),
                            else_=-Cashflow.amount,
                        )
                    ),
                    0,
                ),
            )
            .where(
                Cashflow.pool_id.in_(ids),
                Cashflow.occurred_on < target,
                Cashflow.status == CashflowStatus.APPROVED.value,
            )
            .group_by(Cashflow.pool_id)
        ):
            opening_by_pool[pool_id] = _money(amount)
        for pool_id, direction, nature, amount in session.execute(
            select(
                Cashflow.pool_id,
                Cashflow.direction,
                Cashflow.nature,
                func.coalesce(func.sum(Cashflow.amount), 0),
            )
            .where(
                Cashflow.pool_id.in_(ids),
                Cashflow.occurred_on == target,
                Cashflow.status == CashflowStatus.APPROVED.value,
            )
            .group_by(Cashflow.pool_id, Cashflow.direction, Cashflow.nature)
        ):
            day_cells.setdefault(pool_id, {})[(direction, nature)] = _money(amount)
        for pool_id, amount in session.execute(
            select(Deposit.pool_id, func.coalesce(func.sum(Deposit.paid_amount), 0))
            .where(Deposit.pool_id.in_(ids), Deposit.paid_on == target)
            .group_by(Deposit.pool_id)
        ):
            deposit_paid_by_pool[pool_id] = _money(amount)

    # 池可见性已由上面的 pool_stmt 收敛，这里不再重复做 can_see_pool 校验，
    # 与改动前 pool_balance(session, pool.id) 不传 user 的行为一致。
    balances = pool_balances(session, ids) if ids else {}

    items = []
    for pool in pools:
        bucket = day_cells.get(pool.id, {})
        balance = balances[pool.id]
        items.append(
            {
                "pool_code": pool.code,
                "pool_name": pool.name,
                "opening": opening_by_pool.get(pool.id, ZERO),
                "income": bucket.get(
                    (Direction.IN.value, Nature.BUSINESS_IN.value), ZERO
                ),
                "expense": bucket.get(
                    (Direction.OUT.value, Nature.BUSINESS_OUT.value), ZERO
                ),
                "transfer_in": bucket.get(
                    (Direction.IN.value, Nature.INTERNAL.value), ZERO
                ),
                "transfer_out": bucket.get(
                    (Direction.OUT.value, Nature.INTERNAL.value), ZERO
                ),
                "deposit_paid": deposit_paid_by_pool.get(pool.id, ZERO),
                "deposit_held": balance["deposit_held"],
                "cash_balance": balance["cash_balance"],
                "available": balance["available"],
            }
        )
    return {
        "date": target.isoformat(),
        "items": items,
        "total": {
            "opening": _sum_report_field(items, "opening"),
            "income": _sum_report_field(items, "income"),
            "expense": _sum_report_field(items, "expense"),
            "transfer_in": _sum_report_field(items, "transfer_in"),
            "transfer_out": _sum_report_field(items, "transfer_out"),
            "deposit_paid": _sum_report_field(items, "deposit_paid"),
            "deposit_held": _sum_report_field(items, "deposit_held"),
            "cash_balance": _sum_report_field(items, "cash_balance"),
            "available": _sum_report_field(items, "available"),
        },
    }


# --------------------------------------------------------------------- 订单利润
def order_profit_detail(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """订单利润明细：合计与 R5 对应维度一致，可导出但不改原始数据。

    2026-10-28 性能改造：订单取列级元组、事件损益在 SQL 端按订单条件求和
    （CANCEL 冲销经同单自连接解析），不再全量 ORM 水合事件。返回口径一致。
    """
    _validate_date_range(from_date, to_date)
    orders_stmt = _apply_order_scope(
        select(
            Order.id.label("id"),
            Order.order_no.label("order_no"),
            Order.order_type.label("order_type"),
            Order.trade_date.label("trade_date"),
            Order.status.label("status"),
        ),
        user,
        session,
    )
    orders = session.execute(orders_stmt).all()
    order_ids = [row.id for row in orders]
    extra_values = parties_service.get_extra_values_bulk(
        session, entity_type="order", entity_ids=order_ids
    )
    # 事件损益一次分组聚合替代「全量事件水合 + 逐单 Python 汇总」。
    # 注意每个订单只聚合本单事件：CANCEL 的 offset 归属判定依赖同单事件，
    # 自连接带同单约束，跨单混入不会改口径（与旧实现注释口径一致）。
    totals_by_order: dict[int, tuple[Decimal, Decimal, Decimal]] = {}
    if order_ids:
        offset, (income_case, buy_case, cost_case) = _event_gain_cases(OrderEvent.amount)
        event_agg = (
            select(
                OrderEvent.order_id.label("order_id"),
                func.coalesce(func.sum(income_case), 0).label("income"),
                func.coalesce(func.sum(buy_case), 0).label("buy_amount"),
                func.coalesce(func.sum(cost_case), 0).label("direct_cost"),
            )
            .outerjoin(offset, _event_offset_join(offset))
            .where(OrderEvent.is_posted.is_(True))
            .group_by(OrderEvent.order_id)
        )
        for order_id, income, buy_amount, direct_cost in session.execute(event_agg).all():
            totals_by_order[order_id] = (
                _money(income),
                _money(buy_amount),
                _money(direct_cost),
            )
    settlements_by_order: dict[int, list[tuple[Any, Any, Any]]] = defaultdict(list)
    if order_ids:
        settlement_rows = session.execute(
            select(
                RebateRecord.source_order_id,
                RebateSettlement.gross_amount,
                RebateSettlement.platform_fee,
                RebateSettlement.reversal_of_id,
            )
            .join(
                RebateSettlement, RebateSettlement.rebate_record_id == RebateRecord.id
            )
            .where(RebateRecord.source_order_id.in_(order_ids))
        )
        for source_order_id, gross, fee, reversal_of_id in settlement_rows:
            settlements_by_order[source_order_id].append((gross, fee, reversal_of_id))
    bad_debt_by_order = _bad_debt_by_order(session, user=user)
    no_totals = (_money(0), _money(0), _money(0))
    items = []
    for order in orders:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        income, buy, direct_cost = totals_by_order.get(order.id, no_totals)
        direct_cost += bad_debt_by_order.get(order.id, ZERO)
        rebate = ZERO
        for gross, fee, reversal_of_id in settlements_by_order.get(order.id, []):
            sign = Decimal("-1") if reversal_of_id is not None else Decimal("1")
            rebate += sign * _money(gross)
            direct_cost += sign * _money(fee)
        items.append(
            {
                "order_no": order.order_no,
                "order_id": order.id,
                "order_type": order.order_type,
                "trade_date": order.trade_date.isoformat(),
                "status": order.status,
                "income": income,
                "buy_amount": buy,
                "direct_cost": direct_cost,
                "rebate": rebate,
                "net_profit": income - buy - direct_cost + rebate,
                "extra_values": extra_values.get(order.id, {}),
            }
        )
    return {
        "items": items,
        "total": {
            "income": _sum_report_field(items, "income"),
            "buy_amount": _sum_report_field(items, "buy_amount"),
            "direct_cost": _sum_report_field(items, "direct_cost"),
            "rebate": _sum_report_field(items, "rebate"),
            "net_profit": _sum_report_field(items, "net_profit"),
        },
    }


__all__ = [
    "REPORT_NAMES",
    "daily_funds_report",
    "finance_dimension_report",
    "order_profit_detail",
    "report_csv",
    "report_for_export",
    "r1_inventory_health",
    "r2_monthly_pnl",
    "r3_commission_reconciliation",
    "r5_business_pnl",
]
