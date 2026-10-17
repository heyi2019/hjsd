"""质量检查服务（QLT-01）。

只读扫描当前标准业务数据，不自动修复、不补造事件或现金流；每条异常都携带
可定位的实体类型和实体编号，供异常工作台与人工处置使用。
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AuditAction,
    Direction,
    EventType,
    InstallmentStatus,
    Nature,
    QualityIssueStatus,
    SequenceKey,
)
from app.domain.quality import QualityIssue
from app.domain.trade import (
    Cashflow,
    Installment,
    InstallmentSchedule,
    Order,
    OrderEvent,
    RebateRecord,
)
from app.foundation import service as foundation_service
from app.orders import service as orders_service


MONEY_EVENT_TYPES = frozenset(
    {
        EventType.BUY.value,
        EventType.COST.value,
        EventType.SELL.value,
        EventType.PAYMENT.value,
        EventType.CANCEL.value,
    }
)


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
                    message="已过账动钱事件没有资金池，无法完成资金归集。",
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
                    message="已过账金额事件必须且只能派生一条现金流。",
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
        if order.order_type in {"TH", "DFQ"} and order.account_id is not None:
            issues.append(
                _issue(
                    code="ORDER_ACCOUNT_LINK_INVALID",
                    severity="HIGH",
                    title="文本账号订单错误关联库存",
                    entity_type="order",
                    entity_id=order.order_no,
                    message="TH/DFQ 的账号只能保存在订单账号快照中，不应关联库存账号。",
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
        if rebate.source_order_id is not None and rebate.source_order_id not in order_ids:
            continue
        if (
            rebate.source_order_id is None
            and user is not None
            and not user.is_admin
            and user.owner_scope != "ALL"
        ):
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


def get_issue(session: Session, issue_id: int) -> QualityIssue:
    issue = session.get(QualityIssue, issue_id)
    if issue is None:
        raise NotFound("质量工单不存在", details={"issue_id": issue_id})
    return issue


def list_issues(
    session: Session,
    *,
    status: str | None = None,
    assignee_id: int | None = None,
    code: str | None = None,
) -> list[QualityIssue]:
    stmt = select(QualityIssue)
    if status is not None:
        try:
            QualityIssueStatus(status)
        except ValueError as exc:
            raise Validation(
                f"质量工单状态必须为 {QualityIssueStatus.values()}",
                details={"field": "status", "value": status},
            ) from exc
        stmt = stmt.where(QualityIssue.status == status)
    if assignee_id is not None:
        stmt = stmt.where(QualityIssue.assignee_id == assignee_id)
    if code:
        stmt = stmt.where(QualityIssue.code == code)
    return list(session.scalars(stmt.order_by(QualityIssue.id.desc())).all())


def create_issue(
    session: Session,
    *,
    code: str,
    severity: str,
    title: str,
    entity_type: str,
    entity_id: str,
    message: str,
    actor: str,
    details: dict[str, Any] | None = None,
    assignee_id: int | None = None,
) -> QualityIssue:
    if severity.upper() not in {"CRITICAL", "HIGH", "MEDIUM", "LOW"}:
        raise Validation("质量工单严重级别无效", details={"field": "severity"})
    duplicate = session.scalar(
        select(QualityIssue).where(
            QualityIssue.code == code,
            QualityIssue.entity_type == entity_type,
            QualityIssue.entity_id == entity_id,
            QualityIssue.status != QualityIssueStatus.CLOSED.value,
        )
    )
    if duplicate is not None:
        raise Conflict(
            "同一对象的未关闭异常已存在",
            details={"issue_no": duplicate.issue_no},
        )
    if assignee_id is not None:
        _assert_active_user(session, assignee_id)
    issue = QualityIssue(
        issue_no=allocate_number(session, SequenceKey.QUALITY_ISSUE),
        code=code.strip(),
        severity=severity.upper(),
        title=title.strip(),
        entity_type=entity_type.strip(),
        entity_id=entity_id.strip(),
        message=message.strip(),
        details=details,
        status=QualityIssueStatus.OPEN.value,
        assignee_id=assignee_id,
        created_by=actor,
        updated_by=actor,
    )
    session.add(issue)
    session.flush()
    record_audit(
        session,
        action=AuditAction.QUALITY_ISSUE_CREATE,
        entity_type="quality_issue",
        entity_id=issue.issue_no,
        actor=actor,
        after={"code": issue.code, "entity_id": issue.entity_id},
    )
    return issue


def _assert_active_user(session: Session, user_id: int) -> None:
    from app.domain.users import User

    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise Validation("质量工单负责人必须是启用用户", details={"assignee_id": user_id})


def update_issue(
    session: Session,
    issue_id: int,
    *,
    assignee_id: int | None,
    status: str,
    actor: str,
) -> QualityIssue:
    issue = get_issue(session, issue_id)
    if issue.status == QualityIssueStatus.CLOSED.value:
        raise Conflict("已关闭质量工单不可更新", details={"issue_no": issue.issue_no})
    if status == QualityIssueStatus.CLOSED.value:
        raise Validation("关闭质量工单必须使用 close 接口")
    if assignee_id is not None:
        _assert_active_user(session, assignee_id)
    before = {"assignee_id": issue.assignee_id, "status": issue.status}
    issue.assignee_id = assignee_id
    issue.status = status
    issue.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.QUALITY_ISSUE_UPDATE,
        entity_type="quality_issue",
        entity_id=issue.issue_no,
        actor=actor,
        before=before,
        after={"assignee_id": issue.assignee_id, "status": issue.status},
    )
    return issue


def close_issue(
    session: Session,
    issue_id: int,
    *,
    resolution: str,
    evidence: str | None,
    actor: str,
) -> QualityIssue:
    issue = get_issue(session, issue_id)
    if issue.status == QualityIssueStatus.CLOSED.value:
        raise Conflict("质量工单已关闭", details={"issue_no": issue.issue_no})
    if not resolution.strip():
        raise Validation("关闭质量工单必须填写解决方式", details={"field": "resolution"})
    issue.status = QualityIssueStatus.CLOSED.value
    issue.resolution = resolution.strip()
    issue.evidence = evidence.strip() if evidence else None
    issue.closed_by = actor
    issue.closed_at = datetime.now()
    issue.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.QUALITY_ISSUE_CLOSE,
        entity_type="quality_issue",
        entity_id=issue.issue_no,
        actor=actor,
        after={"status": issue.status, "resolution": issue.resolution},
        reason=issue.resolution,
    )
    return issue


__all__ = [
    "close_issue",
    "create_issue",
    "get_issue",
    "list_issues",
    "scan",
    "summary",
    "update_issue",
]
