"""质量检查服务（QLT-01）。

只读扫描当前标准业务数据，不自动修复、不补造事件或现金流；每条异常都携带
可定位的实体类型和实体编号，供异常工作台与人工处置使用。
"""
from __future__ import annotations

from collections import defaultdict
from calendar import monthrange
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter
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
    RebateRecord,
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
        EventType.COST.value,
        EventType.SELL.value,
        EventType.PAYMENT.value,
        EventType.CANCEL.value,
    }
)

QUALITY_METRIC_DEFINITIONS: dict[str, dict[str, str]] = {
    "linked_rebate_rate": {
        "label": "已关联返点率",
        "formula": "已关联返点记录数 / 返点记录总数",
        "unit": "percent",
    },
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
    "th_outstanding_amount": {
        "label": "TH 未闭环代垫额",
        "formula": "截至月末 TH 现金流支出 - 收入，负数按 0 计",
        "unit": "amount",
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
    """扫描标准库中的可操作异常，结果稳定按严重级别和实体排序。"""
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
    event_ids = {event.id for event in events}
    for event in events:
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
        cashflow_count = session.scalar(
            select(func.count(Cashflow.id)).where(Cashflow.order_event_id == event.id)
        ) or 0
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
        event = session.get(OrderEvent, flow.order_event_id)
        if event is None:
            issues.append(
                _issue(
                    code="ORPHAN_CASHFLOW",
                    severity="CRITICAL",
                    title="孤儿现金流",
                    entity_type="cashflow",
                    entity_id=flow.flow_no,
                    message="现金流引用的业务事件不存在。",
                )
            )
            continue
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
    pools = foundation_service.list_pools(session)
    for pool in pools:
        if user is not None and not user.can_see_pool(pool.id):
            continue
        balance = orders_service.pool_balance(session, pool.id)
        if balance["available"] < 0:
            issues.append(
                _issue(
                    code="NEGATIVE_AVAILABLE",
                    severity="HIGH",
                    title="资金池可用余额为负",
                    entity_type="pool",
                    entity_id=pool.code,
                    message="现金头寸扣除押金占用后出现负数。",
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

    # TH 的净出账大于净入账即表示仍有未核销垫资。
    for order in orders:
        order_events = [event for event in events_by_order.get(order.id, []) if event.is_posted]
        if order.order_type == "DFQ" and order.account_id is not None:
            issues.append(
                _issue(
                    code="ORDER_ACCOUNT_LINK_INVALID",
                    severity="HIGH",
                    title="文本账号订单错误关联库存",
                    entity_type="order",
                    entity_id=order.order_no,
                    message="DFQ 的账号只能保存在订单账号快照中，不应关联库存账号。",
                    details={"order_type": order.order_type, "account_id": order.account_id},
                )
            )
        if order.order_type == "TH":
            outstanding = Decimal("0.00")
            for event in order_events:
                if event.event_type not in MONEY_EVENT_TYPES:
                    continue
                flow = session.scalar(
                    select(Cashflow).where(Cashflow.order_event_id == event.id)
                )
                if flow is None:
                    continue
                outstanding += to_money(flow.amount) if flow.direction == Direction.OUT.value else -to_money(flow.amount)
            if outstanding > 0:
                issues.append(
                    _issue(
                        code="TH_UNCLOSED_ADVANCE",
                        severity="HIGH",
                        title="提号垫资未闭环",
                        entity_type="order",
                        entity_id=order.order_no,
                        message="提号付同行金额尚未被回款或冲销核销。",
                        details={"outstanding": str(outstanding)},
                    )
                )

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

        if order.order_type == "DFQ" and not session.scalar(
            select(Installment.id).where(Installment.order_id == order.id)
        ):
            issues.append(
                _issue(
                    code="INSTALLMENT_MISSING",
                    severity="HIGH",
                    title="代分期订单缺少合约",
                    entity_type="order",
                    entity_id=order.order_no,
                    message="DFQ 订单必须关联一份 ADVANCE_PURCHASE 分期合约。",
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
    for row in schedule_rows:
        installment = session.get(Installment, row.installment_id)
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

    rebates = session.scalars(select(RebateRecord)).all()
    for rebate in rebates:
        if rebate.link_status == "LINKED":
            continue
        if rebate.source_order_id not in order_ids:
            continue
        issues.append(
            _issue(
                code="REBATE_UNLINKED",
                severity="MEDIUM",
                title="返点未关联",
                entity_type="rebate_record",
                entity_id=rebate.rebate_no,
                message="返点记录尚未确认有效订单关联。",
                details={"source_order_id": rebate.source_order_id},
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


def _in_range(value: date, start: date, end: date) -> bool:
    return start <= value <= end


def _percentage(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return round(numerator * 100 / denominator, 2)


def metrics(
    session: Session,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """按月计算质量指标；返回分子、分母和口径，前端不自行推算。"""
    months = _metric_months(from_date, to_date)
    orders = _visible_orders(session, user)
    order_by_id = {order.id: order for order in orders}
    order_ids = set(order_by_id)

    rebates = list(session.scalars(select(RebateRecord)).all())
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        rebates = [
            rebate
            for rebate in rebates
            if rebate.source_order_id in order_ids
        ]
    else:
        rebates = [
            rebate
            for rebate in rebates
            if rebate.source_order_id in order_ids
        ]

    reconciliations = list(session.scalars(select(Reconciliation)).all())
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        reconciliations = [
            item for item in reconciliations if user.can_see_pool(item.pool_id)
        ]

    schedule_rows = list(
        session.execute(
            select(InstallmentSchedule, Installment)
            .join(Installment, Installment.id == InstallmentSchedule.installment_id)
        ).all()
    )
    schedule_rows = [
        (schedule, installment)
        for schedule, installment in schedule_rows
        if installment.order_id in order_ids
    ]

    cashflows = list(session.scalars(select(Cashflow)).all())
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        cashflows = [
            flow
            for flow in cashflows
            if (
                flow.order_id is not None
                and flow.order_id in order_ids
                and user.can_see_pool(flow.pool_id)
            )
            or (
                flow.order_id is None
                and user.can_see_pool(flow.pool_id)
            )
        ]
    else:
        cashflows = [
            flow
            for flow in cashflows
            if flow.order_id is None or flow.order_id in order_ids
        ]
    cashflows = [
        flow for flow in cashflows if flow.status == CashflowStatus.APPROVED.value
    ]

    events = list(
        session.scalars(
            select(OrderEvent).where(
                OrderEvent.order_id.in_(order_ids),
                OrderEvent.is_posted.is_(True),
                OrderEvent.event_type.in_(MONEY_EVENT_TYPES),
            )
        ).all()
    ) if order_ids else []
    attachments = list(
        session.scalars(
            select(Attachment).where(Attachment.deleted_at.is_(None))
        ).all()
    )
    attachment_refs = {(item.entity_type, item.entity_id) for item in attachments}
    th_order_ids = {order.id for order in orders if order.order_type == "TH"}

    items: list[dict[str, Any]] = []
    for month in months:
        end = _month_end(month)
        month_rebates = [
            rebate for rebate in rebates if _in_range(rebate.collected_on, month, end)
        ]
        linked_rebates = sum(
            1
            for rebate in month_rebates
            if rebate.link_status == "LINKED"
        )

        month_reconciliations = [
            item
            for item in reconciliations
            if _in_range(item.reconciled_on, month, end)
        ]
        resolved_reconciliations = sum(
            item.status == ReconciliationStatus.RESOLVED.value
            for item in month_reconciliations
        )

        month_schedules = [
            schedule
            for schedule, _installment in schedule_rows
            if _in_range(schedule.due_on, month, end)
        ]
        overdue_schedules = sum(
            to_money(schedule.received_amount) + to_money(schedule.waived_amount)
            < to_money(schedule.due_amount)
            for schedule in month_schedules
        )

        th_outstanding = Decimal("0.00")
        for flow in cashflows:
            if flow.order_id not in th_order_ids or flow.occurred_on > end:
                continue
            amount = to_money(flow.amount)
            th_outstanding += amount if flow.direction == Direction.OUT.value else -amount
        th_outstanding = max(to_money(th_outstanding), Decimal("0.00"))

        required_refs: list[tuple[str, str]] = [
            ("order_event", event.event_no)
            for event in events
            if _in_range(event.occurred_on, month, end)
        ]
        required_refs.extend(
            ("cashflow", flow.flow_no)
            for flow in cashflows
            if flow.order_event_id is None and _in_range(flow.occurred_on, month, end)
        )
        missing_attachments = sum(
            reference not in attachment_refs for reference in required_refs
        )

        items.append(
            {
                "month": month.strftime("%Y-%m"),
                "linked_rebate_rate": {
                    "rate": _percentage(linked_rebates, len(month_rebates)),
                    "numerator": linked_rebates,
                    "denominator": len(month_rebates),
                },
                "reconciliation_completion_rate": {
                    "rate": _percentage(
                        resolved_reconciliations, len(month_reconciliations)
                    ),
                    "numerator": resolved_reconciliations,
                    "denominator": len(month_reconciliations),
                },
                "overdue_rate": {
                    "rate": _percentage(overdue_schedules, len(month_schedules)),
                    "numerator": overdue_schedules,
                    "denominator": len(month_schedules),
                },
                "th_outstanding_amount": {"amount": f"{th_outstanding:.2f}"},
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
