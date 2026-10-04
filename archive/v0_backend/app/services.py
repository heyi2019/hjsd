"""核算服务：双荷包聚合 + 真实利润。本金与利润严格隔离。"""
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import CashFlow, Order

OPERATION_COST_CATEGORIES = {"房租/日用", "办公用品", "员工薪资", "运营"}


def principal_wallet(db: Session) -> Decimal:
    """本金荷包 = 投资款流入 + 订单本金收入 + 订单本金支出(负值)。

    注意：principal<0 的行是本金支出，其 sum 本身即为负数，必须直接相加。
    此处历史上写成 `- principal_out`，等于把支出翻成正项，会虚增本金。
    """
    invest_in = (
        db.query(func.coalesce(func.sum(CashFlow.amount), 0))
        .filter(CashFlow.category == "投资款", CashFlow.direction == "收入")
        .scalar()
    )
    principal_in = (
        db.query(func.coalesce(func.sum(Order.principal), 0))
        .filter(Order.principal > 0)
        .scalar()
    )
    principal_out = (
        db.query(func.coalesce(func.sum(Order.principal), 0))
        .filter(Order.principal < 0)
        .scalar()
    )
    return Decimal(invest_in) + Decimal(principal_in) + Decimal(principal_out)


def profit_wallet(db: Session) -> Decimal:
    """利润荷包 = 订单利润合计 - 运营消耗(房租日用/办公/薪资/运营)。

    类别名取自金山文档原始枚举，唯一事实源中为「房租/日用」（含斜杠）。
    历史代码误写为「房租日用」，导致该项 ¥11,989.90 从未计入，
    利润荷包被高估 11,989.90（实际为亏损，非盈利）。
    """
    profit_total = db.query(func.coalesce(func.sum(Order.profit), 0)).scalar()
    cost = (
        db.query(func.coalesce(func.sum(CashFlow.amount), 0))
        .filter(CashFlow.category.in_(OPERATION_COST_CATEGORIES), CashFlow.direction == "支出")
        .scalar()
    )
    return Decimal(profit_total) - Decimal(cost)


def monthly_profit(db: Session, year: int, month: int) -> Decimal:
    """真实经营利润(按月) = 当月已实现利润 - 当月运营消耗。本金不计入。

    日期过滤统一用 strftime：SQLite 无 `year()/month()` 函数，
    而 `func.extract` 是 PostgreSQL 方言，跨库不可移植。
    """
    ym = f"{int(year):04d}-{int(month):02d}"
    profit = (
        db.query(func.coalesce(func.sum(Order.profit), 0))
        .filter(func.strftime("%Y-%m", Order.date) == ym)
        .scalar()
    )
    cost = (
        db.query(func.coalesce(func.sum(CashFlow.amount), 0))
        .filter(
            func.strftime("%Y-%m", CashFlow.date) == ym,
            CashFlow.category.in_(OPERATION_COST_CATEGORIES),
            CashFlow.direction == "支出",
        )
        .scalar()
    )
    return Decimal(profit) - Decimal(cost)


def wallet_summary(db: Session) -> dict:
    return {
        "principal_wallet": principal_wallet(db),
        "profit_wallet": profit_wallet(db),
    }
