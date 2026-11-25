"""订单金额口径：事件口径的成交额 / 本金，以及资金明细口径的利润。

为什么单独成模块：
- 报表（app/reporting/）与规则派生（分期服务费基数）必须
  用同一套口径，否则「报表说成交额 1000，返点按 900 计提」这类不一致会查不出来。
- 该口径是订单域事实，不属于报表，下沉到 orders 域避免反向依赖。

口径（勿凭直觉改）：
- GROSS / PRINCIPAL：已过账事件口径，SELL=成交额、BUY=本金占用；成本统一取资金明细；
  CANCEL 仅在其显式 offset 某事件时才做会计冲销；裸取消只改流程状态。
- PROFIT（2026-11-05 用户裁决）：该订单**收入大类 − 支出大类**，可正、可负、可为 0。
  **只有收入、支出两个大类**；业务名词都是大类下的子类型，地位平等、同类同规则：
  · 收入大类：售出价（SELL）、返点、其他一切流入；
  · 支出大类：提号价 / 回收价（BUY）、其他费用、分期坏账、非现金回收成本。
  子类型只在报表里作「其中项」展示（如「其中返点」「其中账号成本」），不是独立的钱，
  绝不再加回净利。
  资金走向不以「有没有生成 cashflow 行」为界：生成流水走流水汇总；不生成流水的
  （返点登记即收入确认 / 分期坏账回收确认）在各源自成口径补入。
- 返点登记即收入确认；退回走真实 OUT 支出流水，不改写已确认收入。
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from decimal import Decimal

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.core.money import to_money, to_money_or_zero
from app.domain.enums import (
    AccountingAttribute,
    Direction,
    EventType,
    InstallmentDispositionAction,
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

    押金线只有**一套逻辑：净额 = 收入 − 支出，为正即利润、为负即损失（损失 = −利润）**。
    真实现金流只有交押金（OUT / DEPOSIT_HOLD）与退回（IN / DEPOSIT_RELEASE|CANCEL）；
    损失不是独立的一笔钱、更不是第二次现金流出，它就是这条线净额为负的结果。
    缴 1000、退 700 ⇒ 净额 −300 ⇒ 损失 300；若把损失再记一笔 OUT，净额会被重复减成
    −600。故资金中心 / 订单利润 / 经营损益聚合**只排除把损失错记成第二次流出的那笔
    DEPOSIT+OUT+非HOLD**，正的利润与负的损失都落在同一个净额公式里。

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


def is_deposit_loss_flow(
    *, accounting_attribute: str | None, direction: str, category: str | None
) -> bool:
    """单行版押金损失判定，与 :func:`business_cashflow_filter` 同源。

    SQL 聚合用 `business_cashflow_filter` 在 WHERE 排除损失流水；而库存详情
    `execution_detail` 的财务汇总在 Python 层遍历已查出的流水对象（且明细列表仍需
    展示损失流水作台账），用本函数在同一处判定「该笔是否为押金损失重分类流水」。
    判定与 SQL 谓词的排除项严格镜像：DEPOSIT + OUT + 非 DEPOSIT_HOLD。
    """
    return (
        accounting_attribute == AccountingAttribute.DEPOSIT.value
        and direction == Direction.OUT.value
        and category != "DEPOSIT_HOLD"
    )


def event_contribution(
    event: OrderEvent, event_types: dict[int, str]
) -> tuple[Decimal, Decimal, Decimal]:
    """返回单个事件的 (income, event_cost, additional_cost)。

    注意：本函数不判断 is_posted，由调用方过滤（与既有行为保持一致）。
    """
    amount = to_money_or_zero(event.amount)
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
    """汇总一批事件的 (income, event_cost, additional_cost)。"""
    event_types = {event.id: event.event_type for event in events}
    income = ZERO
    event_cost = ZERO
    additional_cost = ZERO
    for event in events:
        if not event.is_posted:
            continue
        if from_date and event.occurred_on < from_date:
            continue
        if to_date and event.occurred_on > to_date:
            continue
        event_income, event_amount, event_extra_cost = event_contribution(event, event_types)
        income += event_income
        event_cost += event_amount
        additional_cost += event_extra_cost
    return income, event_cost, additional_cost


def _profit_flow_rows(
    session: Session,
    *,
    order_ids: list[int] | None,
    from_date: date | None,
    to_date: date | None,
) -> list[tuple[int, date, Decimal, Decimal]]:
    """「无资金流水、但有资金走向」的事实明细：(order_id, 归期, 收入, 支出)。

    - 返点记录 = 收入，金额取返点金额 `amount`，按 `collected_on` 归期；
      与库存详情「资金明细」的返点收入行同源（前端标为「收入」）。
    - 分期坏账 = 支出，金额取 `Installment.bad_debt_amount`，按回收处置归期。
    - 分期回收的非现金库存成本 = 新订单支出，按回收入库日期归期。

    返点登记即确认收入并生成资金流水；这里只补尚无对应过账事件的返点记录，
    已有过账事件的由资金流水口径承载，避免重复计入。返点无结算进度 / 作废状态，
    退回走真实 OUT 流水，不在本条补入路径里。
    收入 / 支出归属只按资金走向判定——只有这两个大类。
    """
    rows: list[tuple[int, date, Decimal, Decimal]] = []

    action_model_stmt = select(OrderEvent.source_id).where(
        OrderEvent.event_type == EventType.REBATE.value,
        OrderEvent.source_type == "REBATE",
        OrderEvent.is_posted.is_(True),
    )
    if order_ids is not None:
        action_model_stmt = action_model_stmt.where(OrderEvent.order_id.in_(order_ids))
    action_model_rebate_nos = {
        source_id
        for source_id in session.scalars(action_model_stmt).all()
        if source_id
    }
    rebate_stmt = select(
        RebateRecord.rebate_no,
        RebateRecord.source_order_id,
        RebateRecord.collected_on,
        RebateRecord.amount,
    )
    if order_ids is not None:
        rebate_stmt = rebate_stmt.where(RebateRecord.source_order_id.in_(order_ids))
    if from_date is not None:
        rebate_stmt = rebate_stmt.where(RebateRecord.collected_on >= from_date)
    if to_date is not None:
        rebate_stmt = rebate_stmt.where(RebateRecord.collected_on <= to_date)
    for rebate_no, order_id, occurred_on, amount in session.execute(rebate_stmt).all():
        if rebate_no in action_model_rebate_nos:
            continue
        rows.append((int(order_id), occurred_on, to_money_or_zero(amount), ZERO))

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
        rows.append((int(order_id), occurred_on, ZERO, to_money_or_zero(amount)))

    # 回收估值不是付款，按入库日期计入成本及利润，但不生成资金流水。
    recovery_stmt = select(OrderEvent.order_id, OrderEvent.occurred_on, OrderEvent.amount).where(
        OrderEvent.source_type == "INSTALLMENT_RECOVERY",
        OrderEvent.event_type == EventType.BUY.value,
        OrderEvent.is_posted.is_(True),
    )
    if order_ids is not None:
        recovery_stmt = recovery_stmt.where(OrderEvent.order_id.in_(order_ids))
    if from_date is not None:
        recovery_stmt = recovery_stmt.where(OrderEvent.occurred_on >= from_date)
    if to_date is not None:
        recovery_stmt = recovery_stmt.where(OrderEvent.occurred_on <= to_date)
    for order_id, occurred_on, amount in session.execute(recovery_stmt).all():
        rows.append((int(order_id), occurred_on, ZERO, to_money_or_zero(amount)))

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
    """按订单汇总非现金收入和支出：`{order_id: (收入, 支出)}`。"""
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


def cashflow_buckets_by_order(
    session: Session,
    *,
    order_ids: Iterable[int] | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[int, tuple[Decimal, Decimal, Decimal]]:
    """按订单汇总三大现金流桶：`{order_id: (所有收入, 所有支出, 其中账号成本)}`。

    这是分润基数（``order_cashflow_profit_by_order``）与报表取数
    （``reporting._shared.cashflow_totals_by_order``）共用的**唯一聚合原语**——
    两者从同一个 bucket 投影，杜绝「利润说 100、报表说 90」的口径漂移（PROFIT-02 /
    REPORT-01 铁律）。口径：收入 = 流水 IN + 返点记录；支出 = 流水 OUT + 分期坏账；
    其中账号成本 = category=BUY 的 OUT 流水（仅作报表「其中项」展示，不参与净额）。
    押金损失重分类流水由 ``business_cashflow_filter`` 排除；冲销是反向流水自然计入。
    """
    ids = _resolved_ids(order_ids)
    if ids is not None and not ids:
        return {}
    income_case = case(
        (Cashflow.direction == Direction.IN.value, Cashflow.amount), else_=0
    )
    expense_case = case(
        (Cashflow.direction == Direction.OUT.value, Cashflow.amount), else_=0
    )
    account_cost_case = case(
        (and_(Cashflow.direction == Direction.OUT.value, Cashflow.category == "BUY"),
         Cashflow.amount),
        else_=0,
    )
    stmt = (
        select(
            Cashflow.order_id,
            func.coalesce(func.sum(income_case), 0),
            func.coalesce(func.sum(expense_case), 0),
            func.coalesce(func.sum(account_cost_case), 0),
        )
        .where(Cashflow.order_id.is_not(None), business_cashflow_filter())
        .group_by(Cashflow.order_id)
    )
    if ids is not None:
        stmt = stmt.where(Cashflow.order_id.in_(ids))
    if from_date is not None:
        stmt = stmt.where(Cashflow.occurred_on >= from_date)
    if to_date is not None:
        stmt = stmt.where(Cashflow.occurred_on <= to_date)
    buckets: dict[int, list[Decimal]] = {
        int(order_id): [to_money_or_zero(income), to_money_or_zero(expense), to_money_or_zero(cost)]
        for order_id, income, expense, cost in session.execute(stmt).all()
    }
    for order_id, (rebate_income, noncash_expense) in order_profit_flow_by_order(
        session, order_ids=ids, from_date=from_date, to_date=to_date
    ).items():
        row = buckets.setdefault(order_id, [ZERO, ZERO, ZERO])
        row[0] += rebate_income
        row[1] += noncash_expense
    recovery_costs = select(OrderEvent.order_id, func.sum(OrderEvent.amount)).where(
        OrderEvent.source_type == "INSTALLMENT_RECOVERY",
        OrderEvent.event_type == EventType.BUY.value,
        OrderEvent.is_posted.is_(True),
    ).group_by(OrderEvent.order_id)
    if ids is not None:
        recovery_costs = recovery_costs.where(OrderEvent.order_id.in_(ids))
    if from_date is not None:
        recovery_costs = recovery_costs.where(OrderEvent.occurred_on >= from_date)
    if to_date is not None:
        recovery_costs = recovery_costs.where(OrderEvent.occurred_on <= to_date)
    for order_id, amount in session.execute(recovery_costs).all():
        buckets.setdefault(int(order_id), [ZERO, ZERO, ZERO])[2] += to_money_or_zero(amount)
    return {key: tuple(value) for key, value in buckets.items()}


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
    # 与报表取数共用唯一聚合原语，从同一个 bucket 投影净额（PROFIT-02 铁律）。
    # 本函数不按日期过滤（历史契约），故不传 from_date/to_date。
    return {
        order_id: to_money(income - expense)
        for order_id, (income, expense, _account_cost) in cashflow_buckets_by_order(
            session, order_ids=ids
        ).items()
    }


def order_profit_flow_by_date(
    session: Session,
    *,
    order_ids: Iterable[int] | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[date, tuple[Decimal, Decimal]]:
    """按发生日汇总非现金收入和支出（月度损益 按月聚合用）。"""
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
    不过滤审核状态；冲销流水本身是反向流水，自然被计入。
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
    income, cost, _ = event_totals(events)
    return {
        "GROSS": income,
        "PRINCIPAL": cost,
        "PROFIT": order_cashflow_profit(session, order_id),
    }
