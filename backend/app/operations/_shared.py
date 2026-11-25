"""reporting._shared：报表共用的期间校验、金额归集、坏账与范围过滤工具。

口径红线：账号买入及订单成本通过资金明细归集为成本，**不进运营费用**；返点是收入的其中项，不单列成独立收益、不摊给业务。
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from sqlalchemy import Select
from sqlalchemy.orm import Session
from app.domain.trade import Order
from app.shared.order_amounts import cashflow_buckets_by_order

ZERO = Decimal("0")
REPORT_NAMES = frozenset(
    {
        "monthly-pnl",
        "commission",
        "business-pnl",
        "order-profit",
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


# ----------------------------------------------- 坏账 / 期间 / 范围过滤
def _sum_report_field(items: list[dict[str, Any]], field: str) -> Decimal:
    return sum((item[field] for item in items), ZERO)


def cashflow_totals_by_order(
    session: Session,
    *,
    order_ids: Iterable[int] | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[int, tuple[Decimal, Decimal, Decimal]]:
    """按订单汇总资金明细 (所有收入, 所有支出, 其中账号成本)。

    2026-11-05 用户裁决：利润 = 单订单所有收入 − 所有支出，可正可负可 0；
    资金走向只有收入 / 支出两种，不以「是否生成 cashflow 行」为界。
    本函数是报表侧唯一取数口，与分润基数 `order_cashflow_profit` 同源：
    不看审核状态，收支性质由方向表达；冲销流水本身是反向流水自然计入；
    返点记录（收入）与分期坏账（支出）由 `order_profit_flow_by_order` 补齐。
    押金损失是「已占用押金转费用」的定性转换、非第二次现金流出，由
    `business_cashflow_filter` 排除，与订单利润明细 `order_cashflow_profit_by_order` 同源。
    调用方传入的 order_ids 必须已过权限范围。
    """
    # 聚合口径唯一原语在 shared/order_amounts；报表与分润基数从同一 bucket 投影。
    return cashflow_buckets_by_order(
        session, order_ids=order_ids, from_date=from_date, to_date=to_date
    )


def _month_key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _apply_order_scope(stmt: Select[Any], user: CurrentUser | None, session: Session) -> Select[Any]:
    if user is None:
        return stmt
    scope = owner_scope_filter(Order.owner_id, user, session)
    return stmt.where(scope) if scope is not None else stmt


def _visible_pool_ids(user: CurrentUser | None) -> set[int] | None:
    if user is None or user.is_admin or user.owner_scope == "ALL":
        return None
    return set(user.pool_ids)
