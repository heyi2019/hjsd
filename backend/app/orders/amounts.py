"""订单金额口径：事件口径的成交额 / 本金，以及资金明细口径的利润。

为什么单独成模块：
- 报表（app/reporting/service.py）与规则派生（返点基数、分期服务费基数）必须
  用同一套口径，否则「报表说成交额 1000，返点按 900 计提」这类不一致会查不出来。
- 该口径是订单域事实，不属于报表，下沉到 orders 域避免反向依赖。

口径（勿凭直觉改）：
- GROSS / PRINCIPAL：已过账事件口径，SELL=成交额、BUY=本金占用；直接支出统一取资金明细；
  CANCEL 仅在其显式 offset 某事件时才做会计冲销；裸取消只改流程状态。
- PROFIT（2026-11-05 用户裁决）：该订单**收入大类 − 支出大类**，可正、可负、可为 0。
  **只有收入、支出两个大类**；业务名词都是大类下的子类型，地位平等、同类同规则：
  · 收入大类：售出价（SELL）、返点、其他一切流入；
  · 支出大类：提号价 / 回收价（BUY）、直接费用、分期坏账、其他一切流出。
  子类型只在报表里作「其中项」展示（如「其中返点」「其中买号支出」），不是独立的钱，
  绝不再加回净利。
  资金走向不以「有没有生成 cashflow 行」为界：生成流水走流水汇总；不生成流水的
  （返点登记即收入确认 / 分期坏账回收确认）在各源自成口径补入。
- 作废 ≠ 结算进度：RebateStatus 的 OPEN / PARTIALLY_SETTLED / SETTLED 是结算进度，
  按「登记即计入」都要算收入；**VOID 是作废、不代表任何资金走向，收入侧一律排除**。
  新模型返点作废靠 reverse_cashflow 冲销流水自动减收入，旧模型返点无流水只能靠 status
  排除——两条路径必须让作废返点都不计收入（一致性修复，不是给返点开特例）。
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from decimal import Decimal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.domain.enums import (
    AccountingAttribute,
    Direction,
    EventType,
    InstallmentDispositionAction,
    RebateStatus,
)
from app.domain.trade import (
    Cashflow,
    Installment,
    InstallmentDisposition,
    OrderEvent,
    RebateRecord,
)

ZERO = Decimal("0.00")


def business_cashflow_filter():
    """业务现金流口径：排除「押金损失重分类流水」后的保留条件。

    押金损失（已占用押金转为费用）不是第二次现金流出。押金线的真实现金流只有
    交押金（OUT / DEPOSIT_HOLD）与退回（IN / DEPOSIT_RELEASE|CANCEL）；损失体现为
    该线「收入 − 支出」的净额。故资金中心 / 订单利润 / 经营损益聚合**只排除损失那笔
    OUT**，避免虚增支出与现金流出（缴 1000、退 700、损 300 ⇒ 净支出 700、损失 300，
    不再多记 300 的第二次流出）。

    正向写法规避 SQL 三值逻辑陷阱：放行「非 DEPOSIT 属性（含 NULL）」与
    「DEPOSIT 且（IN 或 category=DEPOSIT_HOLD）」；仅排除 DEPOSIT + OUT + 其他 category
    的损失流水。若写成 NOT(DEPOSIT AND OUT AND ...)，属性为 NULL 的普通流水会因
    NOT(NULL)=NULL 被 WHERE 误删——故坚持正向条件。
    """
    return or_(
        Cashflow.accounting_attribute != AccountingAttribute.DEPOSIT.value,
        Cashflow.accounting_attribute.is_(None),
        and_(
            Cashflow.accounting_attribute == AccountingAttribute.DEPOSIT.value,
            or_(
                Cashflow.direction == Direction.IN.value,
                Cashflow.category == "DEPOSIT_HOLD",
            ),
        ),
    )


def _money(value: object) -> Decimal:
    return to_money(value or 0)


def event_contribution(
    event: OrderEvent, event_types: dict[int, str]
) -> tuple[Decimal, Decimal, Decimal]:
    """返回单个事件的 (income, buy_amount, direct_cost)。

    注意：本函数不判断 is_posted，由调用方过滤（与既有行为保持一致）。
    """
    amount = _money(event.amount)
    if event.event_type == EventType.SELL.value:
        return amount, ZERO, ZERO
    if event.event_type == EventType.BUY.value:
        return ZERO, amount, ZERO
    if event.event_type == EventType.CANCEL.value and event.offset_event_id is not None:
        offset_type = event_types.get(event.offset_event_id)
        if offset_type == EventType.SELL.value:
            return -amount, ZERO, ZERO
        if offset_type == EventType.BUY.value:
            return ZERO, -amount, ZERO
    return ZERO, ZERO, ZERO


def event_totals(
    events: list[OrderEvent], *, from_date: date | None = None, to_date: date | None = None
) -> tuple[Decimal, Decimal, Decimal]:
    """汇总一批事件的 (income, buy_amount, direct_cost)；跳过未过账与越界日期。"""
    event_types = {event.id: event.event_type for event in events}
    income = ZERO
    buy_amount = ZERO
    direct_cost = ZERO
    for event in events:
        if not event.is_posted:
            continue
        if from_date and event.occurred_on < from_date:
            continue
        if to_date and event.occurred_on > to_date:
            continue
        event_income, event_buy, event_cost = event_contribution(event, event_types)
        income += event_income
        buy_amount += event_buy
        direct_cost += event_cost
    return income, buy_amount, direct_cost


def _profit_flow_rows(
    session: Session,
    *,
    order_ids: list[int] | None,
    from_date: date | None,
    to_date: date | None,
) -> list[tuple[int, date, Decimal, Decimal]]:
    """「无资金流水、但有资金走向」的事实明细：(order_id, 归期, 收入, 支出)。

    - 返点记录 = 收入，金额取返点金额 `base_amount`，按 `collected_on` 归期；
      与库存详情「资金明细」的返点收入行同源（前端标为「收入」）。
    - 分期坏账 = 支出，金额取 `Installment.bad_debt_amount`，按回收处置
      `InstallmentDisposition.occurred_on` 归期；一份合约只有一次 RECOVER，
      连接不会放大金额。

    结算进度状态（OPEN / PARTIALLY_SETTLED / SETTLED）不过滤、登记即计入收入；
    VOID 是作废、不代表资金走向，排除（与新模型返点作废 reverse_cashflow 后净额归零同口径）。
    资金性质不改收入 / 支出归属——资金走向只有这两个大类。
    """
    rows: list[tuple[int, date, Decimal, Decimal]] = []

    action_model_rebate_ids = {
        int((extra or {}).get("rebate_record_id"))
        for extra in session.scalars(
            select(OrderEvent.form_extra).where(
                OrderEvent.event_type == EventType.REBATE.value,
                OrderEvent.is_posted.is_(True),
            )
        ).all()
        if isinstance(extra, dict)
        and str((extra or {}).get("rebate_record_id", "")).isdigit()
    }
    rebate_stmt = select(
        RebateRecord.id,
        RebateRecord.source_order_id,
        RebateRecord.collected_on,
        RebateRecord.base_amount,
    ).where(RebateRecord.status != RebateStatus.VOID.value)
    if order_ids is not None:
        rebate_stmt = rebate_stmt.where(RebateRecord.source_order_id.in_(order_ids))
    if from_date is not None:
        rebate_stmt = rebate_stmt.where(RebateRecord.collected_on >= from_date)
    if to_date is not None:
        rebate_stmt = rebate_stmt.where(RebateRecord.collected_on <= to_date)
    for rebate_id, order_id, occurred_on, amount in session.execute(rebate_stmt).all():
        if rebate_id in action_model_rebate_ids:
            continue
        rows.append((int(order_id), occurred_on, _money(amount), ZERO))

    bad_debt_stmt = (
        select(
            Installment.order_id,
            InstallmentDisposition.occurred_on,
            Installment.bad_debt_amount,
        )
        .join(
            InstallmentDisposition,
            InstallmentDisposition.installment_id == Installment.id,
        )
        .where(
            InstallmentDisposition.action == InstallmentDispositionAction.RECOVER.value,
            Installment.bad_debt_amount > 0,
        )
    )
    if order_ids is not None:
        bad_debt_stmt = bad_debt_stmt.where(Installment.order_id.in_(order_ids))
    if from_date is not None:
        bad_debt_stmt = bad_debt_stmt.where(InstallmentDisposition.occurred_on >= from_date)
    if to_date is not None:
        bad_debt_stmt = bad_debt_stmt.where(InstallmentDisposition.occurred_on <= to_date)
    for order_id, occurred_on, amount in session.execute(bad_debt_stmt).all():
        rows.append((int(order_id), occurred_on, ZERO, _money(amount)))

    return rows


def _resolved_ids(order_ids: Iterable[int] | None) -> list[int] | None:
    if order_ids is None:
        return None
    return list(order_ids)


def order_profit_flow_by_order(
    session: Session,
    *,
    order_ids: Iterable[int] | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[int, tuple[Decimal, Decimal]]:
    """按订单汇总返点收入 / 坏账支出：`{order_id: (收入, 支出)}`。"""
    ids = _resolved_ids(order_ids)
    if ids is not None and not ids:
        return {}
    totals: dict[int, list[Decimal]] = defaultdict(lambda: [ZERO, ZERO])
    for order_id, _on, income, expense in _profit_flow_rows(
        session, order_ids=ids, from_date=from_date, to_date=to_date
    ):
        totals[order_id][0] += income
        totals[order_id][1] += expense
    return {key: (value[0], value[1]) for key, value in totals.items()}


def order_cashflow_profit_by_order(
    session: Session,
    *,
    order_ids: Iterable[int] | None = None,
) -> dict[int, Decimal]:
    """按订单批量汇总现金流利润，供列表与报表复用。

    收入 = 资金流水 IN + 返点记录；支出 = 资金流水 OUT + 分期坏账。
    与 :func:`order_cashflow_profit` 使用同一口径，避免订单列表逐行回查或复制利润公式。
    """
    ids = _resolved_ids(order_ids)
    if ids is not None and not ids:
        return {}

    stmt = (
        select(
            Cashflow.order_id,
            Cashflow.direction,
            func.coalesce(func.sum(Cashflow.amount), 0),
        )
        .where(Cashflow.order_id.is_not(None), business_cashflow_filter())
        .group_by(Cashflow.order_id, Cashflow.direction)
    )
    if ids is not None:
        stmt = stmt.where(Cashflow.order_id.in_(ids))

    totals: dict[int, list[Decimal]] = defaultdict(lambda: [ZERO, ZERO])
    for order_id, direction, total in session.execute(stmt).all():
        bucket = totals[int(order_id)]
        if direction == Direction.IN.value:
            bucket[0] += _money(total)
        else:
            bucket[1] += _money(total)

    for order_id, (rebate_income, bad_debt_expense) in order_profit_flow_by_order(
        session, order_ids=ids
    ).items():
        bucket = totals.setdefault(order_id, [ZERO, ZERO])
        bucket[0] += rebate_income
        bucket[1] += bad_debt_expense

    return {
        order_id: to_money(income - expense)
        for order_id, (income, expense) in totals.items()
    }


def order_profit_flow_by_date(
    session: Session,
    *,
    order_ids: Iterable[int] | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[date, tuple[Decimal, Decimal]]:
    """按发生日汇总返点收入 / 坏账支出：`{date: (收入, 支出)}`（R2 按月聚合用）。"""
    ids = _resolved_ids(order_ids)
    if ids is not None and not ids:
        return {}
    totals: dict[date, list[Decimal]] = defaultdict(lambda: [ZERO, ZERO])
    for _order_id, occurred_on, income, expense in _profit_flow_rows(
        session, order_ids=ids, from_date=from_date, to_date=to_date
    ):
        totals[occurred_on][0] += income
        totals[occurred_on][1] += expense
    return {key: (value[0], value[1]) for key, value in totals.items()}


def order_cashflow_profit(session: Session, order_id: int) -> Decimal:
    """订单利润：所有收入 − 所有支出（可正、可负、可为 0）。

    收入 = 资金流水 IN 合计 + 返点记录金额；支出 = 资金流水 OUT 合计 + 分期坏账。
    不过滤审核状态与资金性质；冲销流水本身是反向流水，自然被计入。
    """
    return order_cashflow_profit_by_order(session, order_ids=[order_id]).get(order_id, ZERO)


def order_amounts(session: Session, order_id: int) -> dict[str, Decimal]:
    """按订单取口径金额：成交额 / 本金 / 利润。

    - GROSS：卖出收入合计（成交额，事件口径）
    - PRINCIPAL：买入成本合计（本金占用，事件口径）
    - PROFIT：该订单所有收入 − 所有支出（可负、可 0）
    """
    events = list(
        session.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    )
    income, buy_amount, _ = event_totals(events)
    return {
        "GROSS": income,
        "PRINCIPAL": buy_amount,
        "PROFIT": order_cashflow_profit(session, order_id),
    }
