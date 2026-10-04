"""quality.service：异常检测、工单闭环与校验（QLT-01）。

检测任务 `run_detection` 幂等：同一 (issue_type, entity_type, entity_id) 只开一条 OPEN/ASSIGNED 工单，
复跑不重复计数；已关闭/忽略的不再重开，避免异常「关了又冒出来」。
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CapitalType,
    Direction,
    EventType,
    InstallmentStatus,
    IssueSeverity,
    IssueStatus,
    IssueType,
    LinkStatus,
    Nature,
    OrderStatus,
    RebateStatus,
    ScheduleStatus,
    SequenceKey,
)
from app.domain.foundation import OrderTypeDef, OrderTypePool, Pool
from app.domain.quality import QualityIssue
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentSchedule,
    Order,
    OrderEvent,
    RebateRecord,
)

# 每种异常的默认等级（QLT-01-01 要求「每项有数量、等级」）
SEVERITY_BY_TYPE: dict[str, str] = {
    IssueType.UNROUTED_EVENT.value: IssueSeverity.BLOCKER.value,
    IssueType.SINGLE_SIDED_TRANSFER.value: IssueSeverity.BLOCKER.value,
    IssueType.NEGATIVE_AVAILABLE.value: IssueSeverity.HIGH.value,
    IssueType.TH_UNCLOSED.value: IssueSeverity.HIGH.value,
    IssueType.UNCOLLECTED_REBATE.value: IssueSeverity.MEDIUM.value,
    IssueType.OVERDUE_INSTALLMENT.value: IssueSeverity.MEDIUM.value,
    IssueType.ACCOUNT_CONFLICT.value: IssueSeverity.HIGH.value,
    IssueType.ORPHAN_CASHFLOW.value: IssueSeverity.BLOCKER.value,
    IssueType.HISTORY_UNMAPPED.value: IssueSeverity.LOW.value,
}

OPEN_STATUSES = (IssueStatus.OPEN.value, IssueStatus.ASSIGNED.value)


# --------------------------------------------------------------------- 工单读写
def _issue_out(issue: QualityIssue) -> dict[str, Any]:
    return {
        "id": issue.id,
        "issue_no": issue.issue_no,
        "issue_type": issue.issue_type,
        "severity": issue.severity,
        "status": issue.status,
        "entity_type": issue.entity_type,
        "entity_id": issue.entity_id,
        "entity_label": issue.entity_label,
        "amount": str(to_money(issue.amount)),
        "detected_on": issue.detected_on.isoformat(),
        "owner_id": issue.owner_id,
        "resolution": issue.resolution,
        "closed_at": issue.closed_at.isoformat() if issue.closed_at else None,
        "note": issue.note,
    }


def _issue_filters(
    *,
    issue_type: str | None,
    status: str | None,
    severity: str | None,
    detected_from: date | None,
    detected_to: date | None,
):
    """工单筛选条件：列表与计数必须共用，否则分页 total 会与实际条数不一致。"""
    clauses = []
    if issue_type:
        clauses.append(QualityIssue.issue_type == issue_type.upper())
    if status:
        clauses.append(QualityIssue.status == status.upper())
    if severity:
        clauses.append(QualityIssue.severity == severity.upper())
    if detected_from:
        clauses.append(QualityIssue.detected_on >= detected_from)
    if detected_to:
        clauses.append(QualityIssue.detected_on <= detected_to)
    return clauses


def list_issues(
    session: Session,
    *,
    issue_type: str | None = None,
    status: str | None = None,
    severity: str | None = None,
    detected_from: date | None = None,
    detected_to: date | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict[str, Any]]:
    stmt = select(QualityIssue).order_by(QualityIssue.id.desc())
    stmt = stmt.where(*_issue_filters(
        issue_type=issue_type,
        status=status,
        severity=severity,
        detected_from=detected_from,
        detected_to=detected_to,
    ))
    rows = session.scalars(stmt.limit(limit).offset(offset)).all()
    return [_issue_out(row) for row in rows]


def count_issues(
    session: Session,
    *,
    issue_type: str | None = None,
    status: str | None = None,
    severity: str | None = None,
    detected_from: date | None = None,
    detected_to: date | None = None,
) -> int:
    """满足筛选条件的工单总数（不受 limit/offset 影响），供分页器使用。"""
    stmt = select(func.count(QualityIssue.id)).where(*_issue_filters(
        issue_type=issue_type,
        status=status,
        severity=severity,
        detected_from=detected_from,
        detected_to=detected_to,
    ))
    return int(session.scalar(stmt) or 0)


def get_issue(session: Session, issue_id: int) -> dict[str, Any]:
    issue = session.get(QualityIssue, issue_id)
    if issue is None:
        raise NotFound(f"异常工单 {issue_id} 不存在", details={"issue_id": issue_id})
    return _issue_out(issue)


def _open_issue_keys(session: Session) -> set[tuple[str, str, int | None]]:
    rows = session.execute(
        select(
            QualityIssue.issue_type, QualityIssue.entity_type, QualityIssue.entity_id
        ).where(QualityIssue.status.in_(OPEN_STATUSES))
    ).all()
    return {(r[0], r[1], r[2]) for r in rows}


def _create_issue(
    session: Session,
    *,
    existing: set[tuple[str, str, int | None]],
    actor: str,
    detected_on: date,
    issue_type: str,
    entity_type: str,
    entity_id: int | None,
    entity_label: str,
    amount: Decimal | int | str = 0,
    severity: str | None = None,
    note: str | None = None,
) -> bool:
    key = (issue_type, entity_type, entity_id)
    if key in existing:
        return False
    issue = QualityIssue(
        issue_no=allocate_number(session, SequenceKey.ISSUE.value),
        issue_type=issue_type,
        severity=severity or SEVERITY_BY_TYPE.get(issue_type, IssueSeverity.MEDIUM.value),
        status=IssueStatus.OPEN.value,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_label=entity_label,
        amount=to_money(amount),
        detected_on=detected_on,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(issue)
    session.flush()
    existing.add(key)
    return True


def assign_issue(
    session: Session, issue_id: int, owner_id: int, *, actor: str
) -> dict[str, Any]:
    issue = session.get(QualityIssue, issue_id)
    if issue is None:
        raise NotFound(f"异常工单 {issue_id} 不存在", details={"issue_id": issue_id})
    if issue.status in (IssueStatus.CLOSED.value, IssueStatus.IGNORED.value):
        raise Validation(
            "已关闭或已忽略的工单不可再指派", details={"status": issue.status}
        )
    before = {"owner_id": issue.owner_id, "status": issue.status}
    issue.owner_id = owner_id
    issue.status = IssueStatus.ASSIGNED.value
    issue.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.EXCEPTION_APPROVE,
        entity_type="quality_issue",
        entity_id=issue.id,
        actor=actor,
        before=before,
        after={"owner_id": owner_id, "status": issue.status},
    )
    return _issue_out(issue)


def resolve_issue(
    session: Session,
    issue_id: int,
    *,
    resolution: str,
    actor: str,
    close: bool = True,
) -> dict[str, Any]:
    """处置并关闭。关闭必须填解决方式（QLT-01-05 硬性要求）。"""
    text = (resolution or "").strip()
    if not text:
        raise Validation(
            "关闭异常必须填写解决方式", details={"field": "resolution"}
        )
    issue = session.get(QualityIssue, issue_id)
    if issue is None:
        raise NotFound(f"异常工单 {issue_id} 不存在", details={"issue_id": issue_id})
    before = {"status": issue.status, "resolution": issue.resolution}
    issue.resolution = text
    if close:
        issue.status = IssueStatus.CLOSED.value
        issue.closed_at = datetime.now()
    else:
        issue.status = IssueStatus.RESOLVED.value
    issue.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.EXCEPTION_APPROVE,
        entity_type="quality_issue",
        entity_id=issue.id,
        actor=actor,
        before=before,
        after={"status": issue.status, "resolution": text},
    )
    return _issue_out(issue)


def ignore_issue(
    session: Session, issue_id: int, *, reason: str, actor: str
) -> dict[str, Any]:
    text = (reason or "").strip()
    if not text:
        raise Validation("忽略异常必须填写理由", details={"field": "reason"})
    issue = session.get(QualityIssue, issue_id)
    if issue is None:
        raise NotFound(f"异常工单 {issue_id} 不存在", details={"issue_id": issue_id})
    issue.status = IssueStatus.IGNORED.value
    issue.resolution = text
    issue.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.EXCEPTION_APPROVE,
        entity_type="quality_issue",
        entity_id=issue.id,
        actor=actor,
        before={"status": IssueStatus.OPEN.value},
        after={"status": issue.status, "reason": text},
    )
    return _issue_out(issue)


# --------------------------------------------------------------------- 检测规则
def _detect_unrouted_events(
    session: Session, existing: set, actor: str, today: date
) -> int:
    """未路由事件：已过账但没有池，或业务+份额组合没有配置路由。"""
    routed = {
        (r.order_type_id, r.portion)
        for r in session.scalars(select(OrderTypePool)).all()
    }
    types = {t.id: t.code for t in session.scalars(select(OrderTypeDef)).all()}
    count = 0
    rows = session.execute(
        select(OrderEvent, Order.order_type)
        .join(Order, Order.id == OrderEvent.order_id)
        .where(OrderEvent.is_posted.is_(True))
    ).all()
    for event, order_type_code in rows:
        order_type_id = next(
            (tid for tid, code in types.items() if code == order_type_code), None
        )
        no_pool = event.pool_id is None
        no_route = order_type_id is not None and (
            order_type_id,
            event.portion,
        ) not in routed
        if no_pool or no_route:
            if _create_issue(
                session,
                existing=existing,
                actor=actor,
                detected_on=today,
                issue_type=IssueType.UNROUTED_EVENT.value,
                entity_type="order_event",
                entity_id=event.id,
                entity_label=event.event_no,
                amount=event.amount,
                note="已过账事件缺少资金池路由",
            ):
                count += 1
    return count


def _detect_single_sided_transfer(
    session: Session, existing: set, actor: str, today: date
) -> int:
    """单边划转：同一 transfer_id 不是恰好一进一出且金额相等。"""
    rows = session.execute(
        select(
            Cashflow.transfer_id,
            func.count(Cashflow.id),
            func.sum(
                case(
                    (Cashflow.direction == Direction.IN.value, Cashflow.amount),
                    else_=-Cashflow.amount,
                )
            ),
        )
        .where(Cashflow.transfer_id.isnot(None))
        .group_by(Cashflow.transfer_id)
    ).all()
    count = 0
    for transfer_id, total_count, net in rows:
        if total_count == 2 and to_money(net or 0) == 0:
            continue
        if _create_issue(
            session,
            existing=existing,
            actor=actor,
            detected_on=today,
            issue_type=IssueType.SINGLE_SIDED_TRANSFER.value,
            entity_type="transfer",
            entity_id=None,
            entity_label=str(transfer_id),
            amount=abs(to_money(net or 0)),
            note=f"划转 {transfer_id} 共 {total_count} 条流水，净额 {to_money(net or 0)}",
        ):
            count += 1
    return count


def _detect_negative_available(
    session: Session, existing: set, actor: str, today: date
) -> int:
    from app.orders.service import pool_balance

    count = 0
    for pool in session.scalars(select(Pool)).all():
        balance = pool_balance(session, pool.id)
        if balance["available"] < 0:
            if _create_issue(
                session,
                existing=existing,
                actor=actor,
                detected_on=today,
                issue_type=IssueType.NEGATIVE_AVAILABLE.value,
                entity_type="pool",
                entity_id=pool.id,
                entity_label=pool.code,
                amount=balance["available"],
                note=f"可用余额 {balance['available']}",
            ):
                count += 1
    return count


def _detect_th_unclosed(
    session: Session, existing: set, actor: str, today: date
) -> int:
    """TH 未闭环：代付业务已付同行但未收齐买家款。"""
    count = 0
    rows = session.execute(
        select(Order, OrderEvent)
        .join(OrderEvent, OrderEvent.order_id == Order.id)
        .where(
            Order.capital_type == CapitalType.PASS_THRU.value,
            OrderEvent.event_type == EventType.BUY.value,
            Order.status.in_([OrderStatus.DRAFT.value, OrderStatus.ACTIVE.value]),
        )
    ).all()
    for order, event in rows:
        received = session.scalar(
            select(func.coalesce(func.sum(OrderEvent.amount), 0)).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.SELL.value,
            )
        )
        gap = to_money(event.amount) - to_money(received or 0)
        if gap > 0:
            if _create_issue(
                session,
                existing=existing,
                actor=actor,
                detected_on=today,
                issue_type=IssueType.TH_UNCLOSED.value,
                entity_type="order",
                entity_id=order.id,
                entity_label=order.order_no,
                amount=gap,
                note=f"代付未收差额 {gap}",
            ):
                count += 1
    return count


def _detect_uncollected_rebate(
    session: Session, existing: set, actor: str, today: date
) -> int:
    """未归集返点：返点未关联来源订单（R5 需单列，不摊给业务）。"""
    rows = session.scalars(
        select(RebateRecord).where(
            RebateRecord.status != RebateStatus.VOID.value,
            (RebateRecord.source_order_id.is_(None))
            | (RebateRecord.link_status != LinkStatus.LINKED.value),
        )
    ).all()
    count = 0
    for rebate in rows:
        if _create_issue(
            session,
            existing=existing,
            actor=actor,
            detected_on=today,
            issue_type=IssueType.UNCOLLECTED_REBATE.value,
            entity_type="rebate_record",
            entity_id=rebate.id,
            entity_label=rebate.rebate_group_no,
            amount=rebate.base_amount,
            note="返点未归集到来源订单",
        ):
            count += 1
    return count


def _detect_overdue_installment(
    session: Session, existing: set, actor: str, today: date
) -> int:
    rows = session.execute(
        select(InstallmentSchedule, Installment.inst_no)
        .join(Installment, Installment.id == InstallmentSchedule.installment_id)
        .where(
            InstallmentSchedule.due_on < today,
            InstallmentSchedule.status.in_(
                [ScheduleStatus.PENDING.value, ScheduleStatus.PARTIAL.value]
                if hasattr(ScheduleStatus, "PARTIAL")
                else [ScheduleStatus.PENDING.value]
            ),
            Installment.status.in_(
                [
                    InstallmentStatus.PENDING.value,
                    InstallmentStatus.ACTIVE.value,
                    InstallmentStatus.OVERDUE.value,
                ]
            ),
        )
    ).all()
    count = 0
    for schedule, inst_no in rows:
        gap = to_money(schedule.due_amount) - to_money(schedule.received_amount)
        if _create_issue(
            session,
            existing=existing,
            actor=actor,
            detected_on=today,
            issue_type=IssueType.OVERDUE_INSTALLMENT.value,
            entity_type="installment_schedule",
            entity_id=schedule.id,
            entity_label=f"{inst_no}-{schedule.period_no:02d}",
            amount=gap,
            note=f"应还日 {schedule.due_on.isoformat()}",
        ):
            count += 1
    return count


def _detect_account_conflict(
    session: Session, existing: set, actor: str, today: date
) -> int:
    """账号状态冲突：已售账号仍在库、在库却零成本、被多张未完成单占用。"""
    count = 0

    zero_cost = session.scalars(
        select(Account).where(
            Account.status.in_(
                [AccountStatus.IN_STOCK.value, AccountStatus.SOLD.value]
            ),
            Account.cost_amount == 0,
        )
    ).all()
    for account in zero_cost:
        if _create_issue(
            session,
            existing=existing,
            actor=actor,
            detected_on=today,
            issue_type=IssueType.ACCOUNT_CONFLICT.value,
            entity_type="account",
            entity_id=account.id,
            entity_label=account.account_no,
            note="在库/已售账号成本为 0",
        ):
            count += 1

    # 同一账号被多张未结单占用
    rows = session.execute(
        select(Order.account_id, func.count(Order.id))
        .where(
            Order.account_id.isnot(None),
            Order.status.in_([OrderStatus.DRAFT.value, OrderStatus.ACTIVE.value]),
        )
        .group_by(Order.account_id)
    ).all()
    for account_id, total in rows:
        if total <= 1:
            continue
        account = session.get(Account, account_id)
        if _create_issue(
            session,
            existing=existing,
            actor=actor,
            detected_on=today,
            issue_type=IssueType.ACCOUNT_CONFLICT.value,
            entity_type="account",
            entity_id=account_id,
            entity_label=account.account_no if account else str(account_id),
            note=f"被 {total} 张未结单同时占用",
        ):
            count += 1
    return count


def _detect_orphan_cashflow(
    session: Session, existing: set, actor: str, today: date
) -> int:
    """孤儿流水：业务流水既无事件来源也无划转组，或事件已被删除。"""
    rows = session.scalars(
        select(Cashflow).where(
            Cashflow.nature != Nature.INTERNAL.value,
            Cashflow.order_event_id.is_(None),
        )
    ).all()
    count = 0
    for flow in rows:
        if _create_issue(
            session,
            existing=existing,
            actor=actor,
            detected_on=today,
            issue_type=IssueType.ORPHAN_CASHFLOW.value,
            entity_type="cashflow",
            entity_id=flow.id,
            entity_label=flow.flow_no,
            amount=flow.amount,
            note="业务流水缺少事件来源",
        ):
            count += 1

    dangling = session.execute(
        select(Cashflow.id, Cashflow.flow_no, Cashflow.amount)
        .outerjoin(OrderEvent, OrderEvent.id == Cashflow.order_event_id)
        .where(Cashflow.order_event_id.isnot(None), OrderEvent.id.is_(None))
    ).all()
    for flow_id, flow_no, amount in dangling:
        if _create_issue(
            session,
            existing=existing,
            actor=actor,
            detected_on=today,
            issue_type=IssueType.ORPHAN_CASHFLOW.value,
            entity_type="cashflow",
            entity_id=flow_id,
            entity_label=flow_no,
            amount=amount,
            note="流水指向的事件已不存在",
        ):
            count += 1
    return count


DETECTORS: Sequence = (
    _detect_unrouted_events,
    _detect_single_sided_transfer,
    _detect_negative_available,
    _detect_th_unclosed,
    _detect_uncollected_rebate,
    _detect_overdue_installment,
    _detect_account_conflict,
    _detect_orphan_cashflow,
)


def run_detection(
    session: Session, *, actor: str = "system", today: date | None = None
) -> dict[str, Any]:
    """跑一遍全部检测规则，返回各类新增数（可每日复跑，幂等）。"""
    detected_on = today or date.today()
    existing = _open_issue_keys(session)
    created: dict[str, int] = {}
    for detector in DETECTORS:
        name = detector.__name__.replace("_detect_", "")
        created[name] = detector(session, existing, actor, detected_on)
    session.flush()
    return {
        "detected_on": detected_on.isoformat(),
        "created": created,
        "created_total": sum(created.values()),
    }


def overview(session: Session) -> dict[str, Any]:
    """异常总览：每类异常的数量、等级与跳转入口（QLT-01-01）。"""
    rows = session.execute(
        select(QualityIssue.issue_type, QualityIssue.status, func.count(QualityIssue.id))
        .where(QualityIssue.status.in_(OPEN_STATUSES))
        .group_by(QualityIssue.issue_type, QualityIssue.status)
    ).all()
    summary: dict[str, dict[str, Any]] = {}
    for issue_type, status, total in rows:
        item = summary.setdefault(
            issue_type,
            {
                "issue_type": issue_type,
                "severity": SEVERITY_BY_TYPE.get(issue_type, IssueSeverity.MEDIUM.value),
                "open": 0,
                "assigned": 0,
                "total": 0,
                "entry": f"/quality?issue_type={issue_type}",
            },
        )
        item[status.lower()] = total
        item["total"] += total
    ordered = sorted(
        summary.values(),
        key=lambda x: (
            list(IssueSeverity).index(IssueSeverity(x["severity"])),
            -x["total"],
        ),
    )
    return {
        "total": sum(item["total"] for item in ordered),
        "blockers": sum(
            item["total"]
            for item in ordered
            if item["severity"] == IssueSeverity.BLOCKER.value
        ),
        "items": ordered,
    }


__all__ = [
    "assign_issue",
    "get_issue",
    "ignore_issue",
    "list_issues",
    "overview",
    "resolve_issue",
    "run_detection",
]
