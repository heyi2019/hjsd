"""finance 现金流服务（FIN-04）：登记、冲销与查询。"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.time import now_second
from app.core.money import to_money
from app.core.numbering import allocate_flow_no
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AccountingAttribute,
    AuditAction,
    CashflowStatus,
    Direction,
    Nature,
)
from app.domain.trade import Cashflow, Installment, Order, OrderEvent
from app.finance.attributes import (
    accounting_attributes_for_manual_cashflow,
    validate_fund_accounting_attribute,
)
from app.foundation import service as foundation_service
from app.orders import service as orders_service
from app.orders.form_fields import validate_form_extra
from app.parties import service as parties_service

from ._common import _positive, _text


# 兼容层：押金服务迁至 deposits.py，此处保留原路径导出
from .deposits import (
    cancel_deposit,
    create_deposit,
    list_deposits,
    lose_deposit,
    return_deposit,
)

def _get_cashflow(
    session: Session, cashflow_id: int, user: CurrentUser | None = None
) -> Cashflow:
    flow = session.get(Cashflow, cashflow_id)
    if flow is None:
        raise NotFound(
            f"资金流水 {cashflow_id} 不存在", details={"cashflow_id": cashflow_id}
        )
    if user is not None and not user.can_see_pool(flow.pool_id):
        raise NotFound(
            f"资金流水 {cashflow_id} 不存在", details={"cashflow_id": cashflow_id}
        )
    if user is not None and flow.order_id is not None:
        orders_service.get_order(session, flow.order_id, user)
    return flow


def create_cashflow(
    session: Session,
    *,
    pool_id: int,
    occurred_on: date,
    direction: str,
    nature: str,
    fund_nature: str | None = None,
    accounting_attribute: str | None = None,
    category: str,
    amount: Any,
    actor: str,
    order_id: int | None = None,
    order_event_id: int | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str = "FUNDFLOW",
    user: CurrentUser | None = None,
) -> Cashflow:
    """创建一笔独立现金流；独立录入必须先审核，业务派生流水不走此入口。"""
    try:
        direction = Direction(direction).value
    except ValueError as exc:
        raise Validation(
            f"direction 必须为 {Direction.values()}", details={"field": "direction"}
        ) from exc
    try:
        nature = Nature(nature).value
    except ValueError as exc:
        raise Validation(
            f"nature 必须为 {Nature.values()}", details={"field": "nature"}
        ) from exc
    if nature == Nature.INTERNAL.value:
        raise Validation("独立现金流不能使用 INTERNAL，请使用池间划转")
    if direction == Direction.IN.value and nature not in {
        Nature.EXTERNAL_IN.value,
        Nature.BUSINESS_IN.value,
    }:
        raise Validation("收入流水的 nature 不匹配", details={"direction": direction, "nature": nature})
    if direction == Direction.OUT.value and nature != Nature.BUSINESS_OUT.value:
        raise Validation("支出流水的 nature 不匹配", details={"direction": direction, "nature": nature})
    label = _text(
        category,
        field="category",
        message="category 不能为空",
        uppercase=True,
        type_message="category 必须为文本",
    )
    default_fund_nature, default_accounting_attribute = (
        accounting_attributes_for_manual_cashflow(
            nature=nature, category=label, direction=direction
        )
    )
    fund_nature = fund_nature or default_fund_nature
    accounting_attribute = accounting_attribute or default_accounting_attribute
    try:
        validate_fund_accounting_attribute(fund_nature, accounting_attribute)
    except ValueError as exc:
        raise Validation(str(exc), details={"fund_nature": fund_nature, "accounting_attribute": accounting_attribute}) from exc
    if nature == Nature.EXTERNAL_IN.value and (
        not isinstance(note, str) or not note.strip()
    ):
        raise Validation("独立收款必须填写摘要", details={"field": "note"})
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
    if order_id is not None:
        orders_service.get_order(session, order_id, user)
    if order_event_id is not None:
        from app.domain.trade import OrderEvent

        event = session.get(OrderEvent, order_event_id)
        if event is None or (order_id is not None and event.order_id != order_id):
            raise Validation("资金明细关联的业务事件不存在或不属于该订单")
    money = _positive(amount, field="amount")
    flow = Cashflow(
        flow_no=allocate_flow_no(session, direction),
        pool_id=pool.id,
        occurred_on=occurred_on,
        nature=nature,
        fund_nature=fund_nature,
        accounting_attribute=accounting_attribute,
        category=label,
        direction=direction,
        amount=money,
        order_id=order_id,
        order_event_id=order_event_id,
        status=CashflowStatus.APPROVED.value,
        note=note,
        form_extra=validate_form_extra(session, order_type_code=form_extra_scope, values=form_extra) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)
    session.flush()
    parties_service.set_extra_values(
        session,
        entity_type="cashflow",
        entity_id=flow.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.CASHFLOW_CREATE,
        entity_type="cashflow",
        entity_id=flow.flow_no,
        actor=actor,
        after={
            "status": flow.status,
            "pool_id": pool.id,
            "direction": direction,
            "nature": nature,
            "amount": str(money),
        },
    )
    return flow


def create_order_refund(
    session: Session,
    *,
    order_id: int,
    pool_id: int,
    amount: Any,
    refunded_on: date,
    reason: str,
    actor: str,
    refund_responsibility: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str = "REFUND",
    user: CurrentUser | None = None,
) -> Cashflow:
    """登记售后退款：只写 OUT 资金明细，保留原售出/收款业务事实。"""
    order = orders_service.get_order(session, order_id, user)
    text_reason = _text(
        reason,
        field="reason",
        message="退款必须填写原因",
        type_message="退款必须填写原因",
    )
    responsibility = (refund_responsibility or "COMPANY").strip().upper()
    allowed_responsibilities = {"COMPANY", "CUSTOMER", "CONSIGNOR", "PLATFORM", "OTHER"}
    if responsibility not in allowed_responsibilities:
        raise Validation(
            "退款责任方必须为 COMPANY、CUSTOMER、CONSIGNOR、PLATFORM 或 OTHER",
            details={"field": "refund_responsibility"},
        )
    installment = session.scalar(
        select(Installment).where(Installment.order_id == order.id)
    )
    delivered_type = "DELIVER" if installment is not None else "SELL"
    delivered = session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == delivered_type,
            OrderEvent.is_posted.is_(True),
        )
    )
    if delivered is None:
        raise Validation("交付前请使用取消或冲销，交付后才能退款")
    money = _positive(amount, field="amount")
    received = session.scalar(
        select(func.coalesce(func.sum(Cashflow.amount), 0)).where(
            Cashflow.order_id == order.id,
            Cashflow.direction == Direction.IN.value,
            Cashflow.category.in_(("SELL", "SALE", "INSTALLMENT_PAYMENT")),
            Cashflow.status == CashflowStatus.APPROVED.value,
        )
    ) or 0
    refunded = session.scalar(
        select(func.coalesce(func.sum(Cashflow.amount), 0)).where(
            Cashflow.order_id == order.id,
            Cashflow.direction == Direction.OUT.value,
            Cashflow.category == "REFUND",
            Cashflow.status == CashflowStatus.APPROVED.value,
        )
    ) or 0
    remaining = to_money(received) - to_money(refunded)
    if money > remaining:
        raise Validation(
            f"退款金额超过可退余额 {remaining}",
            details={"remaining_refundable": str(remaining), "amount": str(money)},
        )
    flow = create_cashflow(
        session,
        pool_id=pool_id,
        occurred_on=refunded_on,
        direction=Direction.OUT.value,
        nature=Nature.BUSINESS_OUT.value,
        fund_nature="BUSINESS",
        accounting_attribute=AccountingAttribute.REFUND.value,
        category="REFUND",
        amount=money,
        actor=actor,
        order_id=order.id,
        note=text_reason,
        form_extra=form_extra,
        form_extra_scope=form_extra_scope,
        user=user,
    )
    flow.form_extra = {
        **(flow.form_extra or {}),
        "refund_responsibility": responsibility,
        **({"operator_user_ids": operator_user_ids} if operator_user_ids else {}),
    }
    flow.updated_by = actor
    session.flush()
    return flow


def reverse_cashflow(
    session: Session,
    cashflow_id: int,
    *,
    reversed_on: date,
    actor: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str = "FUNDREVERSE",
    user: CurrentUser | None = None,
) -> Cashflow:
    text_reason = _text(
        reason,
        field="reason",
        message="冲销流水必须填写原因",
        type_message="冲销流水必须填写原因",
    )
    flow = _get_cashflow(session, cashflow_id, user)
    if flow.status != CashflowStatus.APPROVED.value:
        raise Validation("只有已审核流水可以冲销", details={"cashflow_id": cashflow_id})
    if flow.order_event_id is not None:
        event = session.get(OrderEvent, flow.order_event_id)
        if event is None or event.event_type not in {"REBATE", "PROFIT_SHARE"}:
            raise Validation("业务事件现金流必须通过业务事件冲销")
    if flow.deposit_id is not None or flow.transfer_id is not None:
        raise Validation("押金或划转现金流必须通过原业务流程冲销")
    if session.scalar(select(Cashflow.id).where(Cashflow.reversal_of_id == flow.id)):
        raise Validation("该流水已冲销", details={"cashflow_id": cashflow_id})

    if flow.direction == Direction.OUT.value:
        reverse_direction = Direction.IN.value
        reverse_nature = Nature.BUSINESS_IN.value
    else:
        reverse_direction = Direction.OUT.value
        reverse_nature = Nature.BUSINESS_OUT.value
    reversal = Cashflow(
        flow_no=allocate_flow_no(session, reverse_direction),
        pool_id=flow.pool_id,
        occurred_on=reversed_on,
        nature=reverse_nature,
        fund_nature=flow.fund_nature,
        accounting_attribute=AccountingAttribute.REVERSAL.value,
        category="REVERSAL",
        direction=reverse_direction,
        amount=to_money(flow.amount),
        order_id=flow.order_id,
        status=CashflowStatus.APPROVED.value,
        reversal_of_id=flow.id,
        reversal_reason=text_reason,
        note=f"冲销 {flow.flow_no}",
        form_extra=validate_form_extra(session, order_type_code=form_extra_scope, values=form_extra) or None,
        reviewed_by=actor,
        reviewed_at=now_second(),
        created_by=actor,
        updated_by=actor,
    )
    session.add(reversal)
    session.flush()
    record_audit(
        session,
        action=AuditAction.CASHFLOW_REVERSE,
        entity_type="cashflow",
        entity_id=reversal.flow_no,
        actor=actor,
        after={"reversal_of": flow.flow_no, "amount": str(reversal.amount)},
        reason=text_reason,
    )
    return reversal


def _like_pattern(keyword: str) -> str:
    """把用户输入转成 LIKE 模式；转义 `%` 与 `_`，避免关键字被当成通配符。"""
    escaped = (
        keyword.strip()
        .lower()
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    return f"%{escaped}%"


def _apply_cashflow_filters(
    stmt: Select[Any],
    *,
    session: Session,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    order_id: int | None = None,
    direction: str | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    status: str | None = None,
    nature: str | None = None,
    fund_nature: str | None = None,
    accounting_attribute: str | None = None,
    category: str | None = None,
    created_by: str | None = None,
    keyword: str | None = None,
    user: CurrentUser | None = None,
) -> Select[Any]:
    """把资金流水的整套筛选条件套到任意 select 上。

    要求传入的 `stmt` 已 `outerjoin(Order, Order.id == Cashflow.order_id)`：订单归属
    范围（`owner_scope_filter`）与关键字里的订单号都依赖这个 join。

    抽成公共函数的原因：明细查询与合计查询必须用**同一份**条件，否则合计会和列表
    口径漂移（这正是原先由前端各算一遍导致的隐患）。
    """
    if pool_id is not None:
        stmt = stmt.where(Cashflow.pool_id == pool_id)
    elif pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        stmt = stmt.where(Cashflow.pool_id.in_(visible_pool_ids))
    elif user is not None and not (user.is_admin or user.owner_scope == "ALL"):
        stmt = stmt.where(Cashflow.pool_id.in_(sorted(user.pool_ids)))
    if order_id is not None:
        stmt = stmt.where(Cashflow.order_id == order_id)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(Cashflow.order_id.is_(None) | scope)
    if direction is not None:
        stmt = stmt.where(Cashflow.direction == direction)
    if occurred_from is not None:
        stmt = stmt.where(Cashflow.occurred_on >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(Cashflow.occurred_on <= occurred_to)
    if status is not None:
        try:
            status = CashflowStatus(status).value
        except ValueError as exc:
            raise Validation(
                f"status 必须为 {CashflowStatus.values()}",
                details={"field": "status", "value": status},
            ) from exc
        stmt = stmt.where(Cashflow.status == status)
    if nature is not None:
        stmt = stmt.where(Cashflow.nature == nature)
    if fund_nature is not None:
        stmt = stmt.where(Cashflow.fund_nature == fund_nature)
    if accounting_attribute is not None:
        stmt = stmt.where(Cashflow.accounting_attribute == accounting_attribute)
    if category is not None:
        stmt = stmt.where(Cashflow.category == category)
    if created_by is not None:
        stmt = stmt.where(Cashflow.created_by == created_by)
    if keyword is not None and keyword.strip():
        pattern = _like_pattern(keyword)
        stmt = stmt.where(
            or_(
                func.lower(Cashflow.flow_no).like(pattern, escape="\\"),
                func.lower(Cashflow.category).like(pattern, escape="\\"),
                func.lower(func.coalesce(Cashflow.note, "")).like(pattern, escape="\\"),
                func.lower(Order.order_no).like(pattern, escape="\\"),
            )
        )
    return stmt


def _flow_row(flow: Cashflow, order_no: str | None) -> dict[str, Any]:
    """明细行的统一结构；列表与工作室面板共用，避免两处字段慢慢漂移。"""
    if flow.order_event_id is not None:
        source = "ORDER_EVENT"
    elif flow.category in {"REBATE", "REBATE_REVERSAL"}:
        source = "REBATE_SETTLEMENT"
    elif flow.deposit_id is not None or flow.category in {
        "DEPOSIT_HOLD",
        "DEPOSIT_RELEASE",
        "DEPOSIT_LOSS",
    }:
        source = "DEPOSIT"
    elif flow.category == "TRANSFER":
        source = "TRANSFER"
    else:
        source = "OTHER"
    return {
        "id": flow.id,
        "flow_no": flow.flow_no,
        "pool_id": flow.pool_id,
        "occurred_on": flow.occurred_on,
        "occurred_at": flow.created_at,
        "nature": flow.nature,
        "fund_nature": flow.fund_nature,
        "accounting_attribute": flow.accounting_attribute,
        "category": flow.category,
        "direction": flow.direction,
        "amount": flow.amount,
        "status": flow.status,
        "reviewed_by": flow.reviewed_by,
        "reviewed_at": flow.reviewed_at,
        "reversal_of_id": flow.reversal_of_id,
        "order_id": flow.order_id,
        "order_no": order_no,
        "deposit_id": flow.deposit_id,
        "order_event_id": flow.order_event_id,
        "transfer_id": flow.transfer_id,
        "source": source,
        "note": flow.note,
        "operator": flow.created_by,
    }


def list_cashflows(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    order_id: int | None = None,
    direction: str | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    status: str | None = None,
    nature: str | None = None,
    fund_nature: str | None = None,
    accounting_attribute: str | None = None,
    category: str | None = None,
    created_by: str | None = None,
    keyword: str | None = None,
    limit: int = 100,
    offset: int = 0,
    user: CurrentUser | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """统一查询资金明细，直接返回订单号，避免前端按日期和金额猜来源。

    返回 (本页明细, 命中总数)；总数用于前端判断是否还有更多数据。
    关键字搜索覆盖流水号 / 类别 / 摘要 / 订单号，与本函数同一份条件（含合计）一致。
    """
    if pool_id is not None and user is not None and not user.can_see_pool(pool_id):
        return [], 0
    stmt = _apply_cashflow_filters(
        select(Cashflow, Order.order_no).outerjoin(Order, Order.id == Cashflow.order_id),
        session=session,
        pool_id=pool_id,
        pool_ids=pool_ids,
        order_id=order_id,
        direction=direction,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        status=status,
        nature=nature,
        fund_nature=fund_nature,
        accounting_attribute=accounting_attribute,
        category=category,
        created_by=created_by,
        keyword=keyword,
        user=user,
    )

    total = session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows: list[dict[str, Any]] = []
    for flow, order_no in session.execute(
        stmt.order_by(Cashflow.occurred_on.desc(), Cashflow.id.desc())
        .limit(limit)
        .offset(offset)
    ).all():
        rows.append(_flow_row(flow, order_no))
    extras = parties_service.get_extra_values_bulk(
        session, entity_type="cashflow", entity_ids=[row["id"] for row in rows]
    )
    for row in rows:
        row["extra_values"] = extras.get(row["id"], {})
    return rows, total


def cashflow_totals(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    order_id: int | None = None,
    direction: str | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    status: str | None = None,
    nature: str | None = None,
    fund_nature: str | None = None,
    accounting_attribute: str | None = None,
    category: str | None = None,
    created_by: str | None = None,
    keyword: str | None = None,
    user: CurrentUser | None = None,
) -> tuple[Decimal, Decimal]:
    """按与明细**完全相同**的筛选条件，返回 (收入合计, 支出合计)。

    为什么必须在服务端算：列表有 `limit` 上限（当前 2000），前端对当页求和会在流水
    超过上限时静默少算且没有任何提示；聚合走 SQL SUM 也避免前端用浮点累加金额。

    合计只汇总 `amount`，不含任何状态过滤以外的口径：`status` 由调用方传入，传
    什么算什么，与明细列表保持一致。
    """
    if pool_id is not None and user is not None and not user.can_see_pool(pool_id):
        return Decimal("0"), Decimal("0")
    stmt = _apply_cashflow_filters(
        select(Cashflow.direction, func.sum(Cashflow.amount)).outerjoin(
            Order, Order.id == Cashflow.order_id
        ),
        session=session,
        pool_id=pool_id,
        pool_ids=pool_ids,
        order_id=order_id,
        direction=direction,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        status=status,
        nature=nature,
        fund_nature=fund_nature,
        accounting_attribute=accounting_attribute,
        category=category,
        created_by=created_by,
        keyword=keyword,
        user=user,
    ).group_by(Cashflow.direction)
    sums = {
        direction_value: to_money(amount or 0)
        for direction_value, amount in session.execute(stmt).all()
    }
    return sums.get(Direction.IN.value, Decimal("0")), sums.get(Direction.OUT.value, Decimal("0"))


# --------------------------------------------------------------- 工作室手工收支

# 与 `list_cashflows` 里 source 判定保持一致：这几种 category（或挂了押金/事件/划转）
# 都不是「手工登记」，不计入工作室收支。改这里必须同步那段 if/elif。
_MANUAL_EXCLUDED_CATEGORIES = (
    "REBATE",
    "REBATE_REVERSAL",
    "DEPOSIT_HOLD",
    "DEPOSIT_RELEASE",
    "DEPOSIT_LOSS",
    "TRANSFER",
)

# 工作室口径：支出只认「运营消耗」，收入只认「自营收入」——两者是不同的归类，
# 所以不能用一个属性过滤同时拿到两个方向。
STUDIO_EXPENSE_ATTRIBUTE = AccountingAttribute.OPERATING_EXPENSE.value
STUDIO_INCOME_ATTRIBUTE = AccountingAttribute.SELF_REVENUE.value


def _studio_scope() -> Any:
    """「手工登记的工作室收支」的 SQL 条件，与列表里的 source=OTHER 等价。"""
    return and_(
        Cashflow.order_event_id.is_(None),
        Cashflow.deposit_id.is_(None),
        Cashflow.transfer_id.is_(None),
        or_(Cashflow.category.is_(None), Cashflow.category.notin_(_MANUAL_EXCLUDED_CATEGORIES)),
        or_(
            and_(
                Cashflow.direction == Direction.OUT.value,
                Cashflow.accounting_attribute == STUDIO_EXPENSE_ATTRIBUTE,
            ),
            and_(
                Cashflow.direction == Direction.IN.value,
                Cashflow.accounting_attribute == STUDIO_INCOME_ATTRIBUTE,
            ),
        ),
    )


def studio_summary(
    session: Session,
    *,
    pool_ids: Iterable[int] | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    category: str | None = None,
    limit: int = 200,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """工作室收支面板：一次返回明细与已入账汇总。

    为什么单独一个函数：这面板原先在前端发两次 `/cashflows`（收入一次、支出一次），
    自己按 `source === "OTHER"` 过滤、再对当页 reduce 出收入/支出/净额。「哪些流水
    算工作室收支」是业务口径，散在组件里既会随属性调整而漂移，也吃 `limit` 截断。

    返回的 items 与 `list_cashflows` 同结构（含 source/extra_values），前端直接渲染。
    """
    visible_pool_ids = None
    if pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        if not visible_pool_ids:
            # 选了池但一个都无权看：给空结果，而不是放宽成全部池。
            return {
                "items": [],
                "approved_income": Decimal("0"),
                "approved_expense": Decimal("0"),
                "approved_net": Decimal("0"),
                "count": 0,
            }

    common = {
        "session": session,
        "pool_ids": visible_pool_ids,
        "occurred_from": occurred_from,
        "occurred_to": occurred_to,
        "category": category,
        "user": user,
    }

    list_stmt = _apply_cashflow_filters(
        select(Cashflow, Order.order_no).outerjoin(Order, Order.id == Cashflow.order_id),
        **common,
    ).where(_studio_scope())
    rows: list[dict[str, Any]] = []
    for flow, order_no in session.execute(
        list_stmt.order_by(Cashflow.occurred_on.desc(), Cashflow.id.desc()).limit(limit)
    ).all():
        rows.append(_flow_row(flow, order_no))

    # 汇总只算已入账（APPROVED）：待审核/已驳回的不能进经营口径。
    totals_stmt = _apply_cashflow_filters(
        select(Cashflow.direction, func.sum(Cashflow.amount)).outerjoin(
            Order, Order.id == Cashflow.order_id
        ),
        **common,
    ).where(_studio_scope(), Cashflow.status == CashflowStatus.APPROVED.value).group_by(Cashflow.direction)
    sums = {
        direction_value: to_money(amount or 0)
        for direction_value, amount in session.execute(totals_stmt).all()
    }
    income = sums.get(Direction.IN.value, Decimal("0.00"))
    expense = sums.get(Direction.OUT.value, Decimal("0.00"))

    extras = parties_service.get_extra_values_bulk(
        session, entity_type="cashflow", entity_ids=[row["id"] for row in rows]
    )
    for row in rows:
        row["extra_values"] = extras.get(row["id"], {})

    return {
        "items": rows,
        "approved_income": income,
        "approved_expense": expense,
        "approved_net": income - expense,
        "count": len(rows),
    }



__all__ = [
    "STUDIO_EXPENSE_ATTRIBUTE",
    "STUDIO_INCOME_ATTRIBUTE",
    "cancel_deposit",
    "cashflow_totals",
    "create_cashflow",
    "create_deposit",
    "list_cashflows",
    "list_deposits",
    "lose_deposit",
    "return_deposit",
    "reverse_cashflow",
    "studio_summary",
]
