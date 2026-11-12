"""质量检查服务（QLT-01）。

只读扫描当前标准业务数据，不自动修复、不补造事件或现金流；每条异常都携带
可定位的实体类型和实体编号，供异常工作台与人工处置使用。
"""
from __future__ import annotations

from collections import defaultdict
from calendar import monthrange
from datetime import date
from typing import Any

from sqlalchemy import case, false, func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter
from app.core.sql_functions import year_month
from app.domain.enums import (
    CashflowStatus,
    Direction,
    EventType,
    InstallmentStatus,
    Nature,
    ReconciliationStatus,
    QualityIssueStatus,
)
from app.domain.attachments import Attachment
from app.domain.trade import (
    Cashflow,
    Installment,
    InstallmentSchedule,
    Order,
    OrderEvent,
    Reconciliation,
)
from app.domain.quality import QualityIssue
from app.foundation import service as foundation_service
from app.orders import service as orders_service

from .issues import (
    batch_close_issues,
    close_issue,
    create_issue,
    get_issue,
    list_issues,
    update_issue,
)


MONEY_EVENT_TYPES = frozenset(
    {
        EventType.BUY.value,
        EventType.SELL.value,
        EventType.CANCEL.value,
    }
)

QUALITY_METRIC_DEFINITIONS: dict[str, dict[str, str]] = {
    "reconciliation_completion_rate": {
        "label": "对账完成率",
        "formula": "已核销对账数 / 对账总数",
        "unit": "percent",
    },
    "overdue_rate": {
        "label": "分期逾期率",
        "formula": "期末已逾期计划数 / 当月到期计划数",
        "unit": "percent",
    },
    "missing_attachment_rate": {
        "label": "缺附件率",
        "formula": "无附件的已登记金额事件和独立流水 / 应有凭证记录总数",
        "unit": "percent",
    },
}


def _issue(
    *,
    code: str,
    severity: str,
    title: str,
    entity_type: str,
    entity_id: str | int,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "title": title,
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "message": message,
        "details": details or {},
    }


def _visible_orders(session: Session, user: CurrentUser | None) -> list[Order]:
    stmt = select(Order)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return list(session.scalars(stmt.order_by(Order.id)).all())


def scan(session: Session, *, user: CurrentUser | None = None) -> list[dict[str, Any]]:
    """扫描标准库中的可操作异常，结果稳定按严重级别和实体排序。

    复杂度画像（2026-10-28 实测，含每规模独立进程复测）：
    - SQL 条数恒定 12 条，不随行数增长（护栏见 test_quality_guard 的
      ``test_scan_sql_count_does_not_grow_with_rows``）；
    - 耗时线性 O(订单数+事件数)，≈63µs/单：632 单 62ms、1.06 万单 460ms、
      5.06 万单 2.2s、10.06 万单 6.3s（零异常合成数据，瓶颈在 ORM 全量
      水合与 Python 侧遍历，不在 SQL）。
    - 结论：当前量级（数百单）无需改分批游标；订单过 **5 万** 再考虑把
      全量 ORM 载入改为按窗口迭代的轻量列查询。
    """
    issues: list[dict[str, Any]] = []
    orders = _visible_orders(session, user)
    order_by_id = {order.id: order for order in orders}
    order_ids = set(order_by_id)

    events = list(
        session.scalars(
            select(OrderEvent)
            .where(OrderEvent.order_id.in_(order_ids))
            .order_by(OrderEvent.order_id, OrderEvent.id)
        ).all()
    )
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    events_by_id: dict[int, OrderEvent] = {}
    event_ids = {event.id for event in events}
    # 每个事件的现金流条数一次聚合取回。逐事件 COUNT 是 O(事件数) 条 SQL
    # （真实库实测 740 条 / 单次请求 919 条），聚合后恒为 1 条。
    cashflow_counts: dict[int, int] = {}
    if event_ids:
        cashflow_counts = {
            event_id: count
            for event_id, count in session.execute(
                select(Cashflow.order_event_id, func.count(Cashflow.id))
                .where(Cashflow.order_event_id.in_(event_ids))
                .group_by(Cashflow.order_event_id)
            ).all()
            if event_id is not None
        }
    for event in events:
        events_by_id[event.id] = event
        events_by_order[event.order_id].append(event)
        if not event.is_posted or event.event_type not in MONEY_EVENT_TYPES:
            continue
        if event.pool_id is None:
            issues.append(
                _issue(
                    code="EVENT_POOL_MISSING",
                    severity="HIGH",
                    title="事件缺少资金池",
                    entity_type="order_event",
                    entity_id=event.event_no,
                    message="已登记动钱事件没有资金池，无法完成资金归集。",
                    details={"order_no": order_by_id[event.order_id].order_no},
                )
            )
        cashflow_count = cashflow_counts.get(event.id, 0)
        if cashflow_count != 1:
            issues.append(
                _issue(
                    code="EVENT_CASHFLOW_MISMATCH",
                    severity="CRITICAL",
                    title="事件与现金流不一致",
                    entity_type="order_event",
                    entity_id=event.event_no,
                    message="已登记金额事件必须且只能派生一条现金流。",
                    details={"cashflow_count": cashflow_count},
                )
            )

    # 现金流与来源事件的池、订单和金额必须保持同一事实源。
    for flow in session.scalars(
        select(Cashflow)
        .where(Cashflow.order_event_id.is_not(None))
        .order_by(Cashflow.id)
    ).all():
        if flow.order_event_id not in event_ids:
            continue
        event = events_by_id[flow.order_event_id]
        mismatches: dict[str, str] = {}
        if flow.order_id != event.order_id:
            mismatches["order_id"] = f"{flow.order_id}!={event.order_id}"
        if flow.pool_id != event.pool_id:
            mismatches["pool_id"] = f"{flow.pool_id}!={event.pool_id}"
        if to_money(flow.amount) != to_money(event.amount):
            mismatches["amount"] = f"{flow.amount}!={event.amount}"
        if mismatches:
            issues.append(
                _issue(
                    code="CASHFLOW_SOURCE_MISMATCH",
                    severity="CRITICAL",
                    title="现金流来源不一致",
                    entity_type="cashflow",
                    entity_id=flow.flow_no,
                    message="现金流必须与来源事件的订单、资金池和金额一致。",
                    details=mismatches,
                )
            )

    # 跨池划转必须有一进一出，金额相等且方向相反。
    transfer_rows: dict[str, list[Cashflow]] = defaultdict(list)
    for flow in session.scalars(
        select(Cashflow).where(
            Cashflow.transfer_id.is_not(None), Cashflow.nature == Nature.INTERNAL.value
        )
    ).all():
        transfer_rows[flow.transfer_id].append(flow)
    for transfer_id, rows in transfer_rows.items():
        if user is not None and not user.is_admin and user.owner_scope != "ALL":
            visible_pool_ids = user.pool_ids
            if not visible_pool_ids or any(row.pool_id not in visible_pool_ids for row in rows):
                continue
        amounts = {to_money(row.amount) for row in rows}
        directions = {row.direction for row in rows}
        if len(rows) != 2 or len(amounts) != 1 or directions != {
            Direction.IN.value,
            Direction.OUT.value,
        }:
            issues.append(
                _issue(
                    code="TRANSFER_UNPAIRED",
                    severity="CRITICAL",
                    title="划转不是成对流水",
                    entity_type="transfer",
                    entity_id=transfer_id,
                    message="内部划转必须是一进一出且金额相等。",
                    details={
                        "row_count": len(rows),
                        "amounts": [str(amount) for amount in amounts],
                        "directions": sorted(directions),
                    },
                )
            )

    # 资金池可用余额不能为负；只检查用户有权看到的池。
    # 余额改成一次批量聚合：逐池调用 pool_balance 会让 SQL 条数按「池数 × 3」放大
    # （真实库 7 个池实测 21 条），批量后恒为 3 条。
    pools = [
        pool
        for pool in foundation_service.list_pools(session)
        if user is None or user.can_see_pool(pool.id)
    ]
    balances = (
        orders_service.pool_balances(session, [pool.id for pool in pools], user=user)
        if pools
        else {}
    )
    for pool in pools:
        balance = balances[pool.id]
        if balance["available"] < 0:
            issues.append(
                _issue(
                    code="NEGATIVE_AVAILABLE",
                    severity="HIGH",
                    title="资金池可用余额为负",
                    entity_type="pool",
                    entity_id=pool.code,
                    message="现金头寸（已含押金占用流出）为负。",
                    details={
                        "income": str(balance["income"]),
                        "expense": str(balance["expense"]),
                        "transfer_in": str(balance["transfer_in"]),
                        "transfer_out": str(balance["transfer_out"]),
                        "cash_balance": str(balance["cash_balance"]),
                        "deposit_held": str(balance["deposit_held"]),
                        "available": str(balance["available"]),
                    },
                )
            )

    for order in orders:
        order_events = [event for event in events_by_order.get(order.id, []) if event.is_posted]
        if order.order_type == "HS" and order.capital_type == "STOCK" and order.account_id is None:
            if any(event.event_type == EventType.BUY.value and event.is_posted for event in order_events):
                issues.append(
                    _issue(
                        code="INVENTORY_ACCOUNT_MISSING",
                        severity="HIGH",
                        title="库存型订单缺少账号",
                        entity_type="order",
                        entity_id=order.order_no,
                        message="库存型 HS 买入后必须能追溯到库存账号。",
                    )
                )

    schedule_rows = session.scalars(
        select(InstallmentSchedule)
        .join(Installment, Installment.id == InstallmentSchedule.installment_id)
        .where(
            Installment.status.notin_(
                (
                    InstallmentStatus.SETTLED.value,
                    InstallmentStatus.DELIVERED.value,
                    InstallmentStatus.CANCELLED.value,
                )
            ),
            InstallmentSchedule.due_on < date.today(),
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
            InstallmentSchedule.status != "PAID",
        )
    ).all()
    # 逾期计划对应的合约一次批量取回：逐行 session.get 是 O(逾期计划数) 条 SQL
    # （实测 28 条），且依赖 identity map 命中，一旦调用方 commit 就会退化成 N+1。
    installments_by_id: dict[int, Installment] = {}
    schedule_installment_ids = {row.installment_id for row in schedule_rows}
    if schedule_installment_ids:
        installments_by_id = {
            item.id: item
            for item in session.scalars(
                select(Installment).where(Installment.id.in_(schedule_installment_ids))
            ).all()
        }
    for row in schedule_rows:
        installment = installments_by_id.get(row.installment_id)
        if installment is None or installment.order_id not in order_ids:
            continue
        issues.append(
            _issue(
                code="INSTALLMENT_OVERDUE",
                severity="HIGH",
                title="分期已逾期",
                entity_type="installment",
                entity_id=installment.inst_no,
                message=f"第 {row.period_no} 期已超过到期日且未收满。",
                details={"period_no": row.period_no, "due_on": row.due_on.isoformat()},
            )
        )

    severity_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    return sorted(
        issues,
        key=lambda item: (
            severity_rank.get(item["severity"], 9),
            item["code"],
            item["entity_type"],
            item["entity_id"],
        ),
    )


def summary(session: Session, *, user: CurrentUser | None = None) -> dict[str, Any]:
    issues = scan(session, user=user)
    by_severity: dict[str, int] = defaultdict(int)
    by_code: dict[str, int] = defaultdict(int)
    for item in issues:
        by_severity[item["severity"]] += 1
        by_code[item["code"]] += 1
    return {
        "total": len(issues),
        "by_severity": dict(sorted(by_severity.items())),
        "by_code": dict(sorted(by_code.items())),
        "items": issues,
    }


def scan_and_record(
    session: Session,
    *,
    actor: str,
    user: CurrentUser | None = None,
) -> list[QualityIssue]:
    """将本次扫描发现的异常责任化落库，已存在的未关闭工单不重复创建。"""
    created: list[QualityIssue] = []
    for item in scan(session, user=user):
        duplicate = session.scalar(
            select(QualityIssue).where(
                QualityIssue.code == item["code"],
                QualityIssue.entity_type == item["entity_type"],
                QualityIssue.entity_id == item["entity_id"],
                QualityIssue.status != QualityIssueStatus.CLOSED.value,
            )
        )
        if duplicate is not None:
            continue
        created.append(
            create_issue(
                session,
                code=item["code"],
                severity=item["severity"],
                title=item["title"],
                entity_type=item["entity_type"],
                entity_id=item["entity_id"],
                message=item["message"],
                details=item.get("details"),
                actor=actor,
            )
        )
    return created


def _month_start(value: date) -> date:
    return value.replace(day=1)


def _month_end(value: date) -> date:
    return value.replace(day=monthrange(value.year, value.month)[1])


def _next_month(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


def _metric_months(
    from_date: date | None,
    to_date: date | None,
) -> list[date]:
    if from_date is not None and to_date is not None and from_date > to_date:
        raise Validation(
            "开始日期不能晚于结束日期",
            details={"from": from_date.isoformat(), "to": to_date.isoformat()},
        )
    start = _month_start(from_date or to_date or date.today())
    end = _month_start(to_date or from_date or date.today())
    result: list[date] = []
    cursor = start
    while cursor <= end:
        result.append(cursor)
        cursor = _next_month(cursor)
    return result


def _percentage(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return round(numerator * 100 / denominator, 2)


def _pool_column_filter(column: Any, pool_ids: tuple[int, ...]) -> Any:
    """池可见性过滤；空授权集合视为不可见任何池。"""
    return column.in_(pool_ids) if pool_ids else false()


def metrics(
    session: Session,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """按月计算质量指标；返回分子、分母和口径，前端不自行推算。

    2026-10-28 性能改造：统计全部下沉 SQL 端聚合/过滤，不再把对账、流水、
    事件、附件全表 ORM 水合进内存（并发下占满事件循环，是读路径 p95 8s 的
    主因之一）。返回口径与旧实现逐字段一致：
    - 逾期判定：金额列底层为 REAL 存储，SQL 端按「分位取整」比较，与
      Python Decimal 2 位量化口径严格一致；
    - 池可见性：can_see_pool 即 pool_ids 集合判定，直接翻译为 IN 过滤。
    """
    months = _metric_months(from_date, to_date)

    order_ids_query = select(Order.id)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            order_ids_query = order_ids_query.where(scope)

    restricted = user is not None and not user.is_admin and user.owner_scope != "ALL"
    pool_ids = tuple(user.pool_ids) if restricted else ()

    # 对账：按月聚合（总数 + 已核销数），池可见性过滤下沉 SQL。
    recon_stmt = select(
        year_month(Reconciliation.reconciled_on).label("month"),
        func.count().label("total"),
        func.sum(
            case(
                (Reconciliation.status == ReconciliationStatus.RESOLVED.value, 1),
                else_=0,
            )
        ).label("resolved"),
    ).group_by("month")
    if restricted:
        recon_stmt = recon_stmt.where(_pool_column_filter(Reconciliation.pool_id, pool_ids))
    recon_by_month = {
        row.month: (int(row.total or 0), int(row.resolved or 0))
        for row in session.execute(recon_stmt).all()
    }

    # 分期计划：按月聚合（到期数 + 逾期数），订单可见性经子查询下沉 SQL。
    sched_stmt = (
        select(
            year_month(InstallmentSchedule.due_on).label("month"),
            func.count().label("total"),
            func.sum(
                case(
                    (
                        func.round(
                            InstallmentSchedule.received_amount * 100
                            + InstallmentSchedule.waived_amount * 100
                        )
                        < func.round(InstallmentSchedule.due_amount * 100),
                        1,
                    ),
                    else_=0,
                )
            ).label("overdue"),
        )
        .join(Installment, Installment.id == InstallmentSchedule.installment_id)
        .where(Installment.order_id.in_(order_ids_query))
        .group_by("month")
    )
    sched_by_month = {
        row.month: (int(row.total or 0), int(row.overdue or 0))
        for row in session.execute(sched_stmt).all()
    }

    # 缺附件判定的引用来源：金额事件 + 无关联事件的已审流水，只取编号与发生日。
    event_refs_by_month: dict[str, list[str]] = defaultdict(list)
    for event_no, occurred_on in session.execute(
        select(OrderEvent.event_no, OrderEvent.occurred_on).where(
            OrderEvent.order_id.in_(order_ids_query),
            OrderEvent.is_posted.is_(True),
            OrderEvent.event_type.in_(MONEY_EVENT_TYPES),
        )
    ).all():
        event_refs_by_month[occurred_on.strftime("%Y-%m")].append(event_no)

    flow_stmt = select(Cashflow.flow_no, Cashflow.occurred_on).where(
        Cashflow.status == CashflowStatus.APPROVED.value,
        Cashflow.order_event_id.is_(None),
        or_(Cashflow.order_id.is_(None), Cashflow.order_id.in_(order_ids_query)),
    )
    if restricted:
        flow_stmt = flow_stmt.where(_pool_column_filter(Cashflow.pool_id, pool_ids))
    flow_refs_by_month: dict[str, list[str]] = defaultdict(list)
    for flow_no, occurred_on in session.execute(flow_stmt).all():
        flow_refs_by_month[occurred_on.strftime("%Y-%m")].append(flow_no)

    # 附件引用集合：只取两列并限定相关实体类型，避免全列水合。
    attachment_refs = set(
        session.execute(
            select(Attachment.entity_type, Attachment.entity_id).where(
                Attachment.deleted_at.is_(None),
                Attachment.entity_type.in_(("order_event", "cashflow")),
            )
        ).all()
    )

    items: list[dict[str, Any]] = []
    for month in months:
        key = month.strftime("%Y-%m")
        recon_total, resolved_reconciliations = recon_by_month.get(key, (0, 0))
        sched_total, overdue_schedules = sched_by_month.get(key, (0, 0))

        required_refs: list[tuple[str, str]] = [
            ("order_event", event_no)
            for event_no in event_refs_by_month.get(key, ())
        ]
        required_refs.extend(
            ("cashflow", flow_no) for flow_no in flow_refs_by_month.get(key, ())
        )
        missing_attachments = sum(
            reference not in attachment_refs for reference in required_refs
        )

        items.append(
            {
                "month": month.strftime("%Y-%m"),
                "reconciliation_completion_rate": {
                    "rate": _percentage(resolved_reconciliations, recon_total),
                    "numerator": resolved_reconciliations,
                    "denominator": recon_total,
                },
                "overdue_rate": {
                    "rate": _percentage(overdue_schedules, sched_total),
                    "numerator": overdue_schedules,
                    "denominator": sched_total,
                },
                "missing_attachment_rate": {
                    "rate": _percentage(missing_attachments, len(required_refs)),
                    "numerator": missing_attachments,
                    "denominator": len(required_refs),
                },
            }
        )
    return {
        "from": months[0].isoformat(),
        "to": _month_end(months[-1]).isoformat(),
        "definitions": QUALITY_METRIC_DEFINITIONS,
        "items": items,
    }




__all__ = [
    "batch_close_issues",
    "close_issue",
    "create_issue",
    "get_issue",
    "list_issues",
    "metrics",
    "scan",
    "scan_and_record",
    "summary",
    "update_issue",
]
