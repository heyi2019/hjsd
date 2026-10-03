"""M0 核算服务 —— 实现 PRD §3 的5 条恒等式。

与旧services.py 的关键差异：

- 旧 `principal_wallet()` / `profit_wallet()` **已删除**。
  前者因迁移时剔除本金支出侧而虚高（237,646.49），后者漏计库存沉淀（−8,703.69）。
- 改为按池核算：`pool_balance(pool_id)` 分池计算，合并后等于真实现金头寸。
- 库存占用只计 `STOCK` + `CREDIT`，**排除 `PASS_THRU`**（提号逐笔对冲，零库存）。

已实测基线（2026-07 ~ 10-03 真实数据）：
    池余额合计= 45,331.53
    库存占用     ≤ 74,212.41（回收买号 71,305.41 + 代分期垫资 2,907.00）
    经营损益     = −8,839.69
    权益         = −54,668.47
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models_new.entities import (
    Account, CashFlow, Installment, OPERATING_COST_CATEGORIES, Order,
    OrderEvent, Pool, RebateRecord,
)

ZERO = Decimal("0")


# ---------------------------------------------------------------------------
# 恒等式①：单池余额
# ---------------------------------------------------------------------------

def pool_balance(db: Session, pool_id: int) -> Decimal:
    """单池余额 = Σ(EXTERNAL_IN + BUSINESS_IN) − Σ(BUSINESS_OUT) + INTERNAL 净流入。

    INTERNAL 只在同一 pool 内一进一出，净额为 0，因此这里按 pool 分组后
    仍然正确——跨池划转的两条流水分属不同 pool_id，各自只见到自己那条。
    """
    inflow = db.query(
        func.coalesce(func.sum(CashFlow.amount), 0)
    ).filter(
        CashFlow.pool_id == pool_id,
        CashFlow.nature.in_(("EXTERNAL_IN", "BUSINESS_IN")),
    ).scalar()

    outflow = db.query(
        func.coalesce(func.sum(CashFlow.amount), 0)
    ).filter(
        CashFlow.pool_id == pool_id,
        CashFlow.nature == "BUSINESS_OUT",
    ).scalar()

    internal = db.query(
        func.coalesce(
            func.sum(
                func.iif(CashFlow.direction == "收入", CashFlow.amount, -CashFlow.amount)
            ),
            0,
        )
    ).filter(
        CashFlow.pool_id == pool_id,
        CashFlow.nature == "INTERNAL",
    ).scalar()

    return Decimal(inflow) - Decimal(outflow) + Decimal(internal)


def all_pools_balance(db: Session, only_owned: bool = False) -> dict:
    """全池余额明细 + 合计。合计应等于真实现金净头寸。

    池的数量与类型不固定：新增池后本函数自动纳入，无需改代码。
    `only_owned=True` 时只统计自有资金池（ownership=OWNED），
    用于权益核算——代客保管、平台保证金不是工作室的钱。
    """
    q = db.query(Pool).order_by(Pool.id)
    if only_owned:
        q = q.filter(Pool.ownership == "OWNED")

    rows = []
    total = ZERO
    for p in q.all():
        bal = pool_balance(db, p.id)
        total += bal
        rows.append({
            "pool_id": p.id,
            "code": p.code,
            "name": p.name,
            "pool_type": p.pool_type,
            "ownership": p.ownership,
            "balance": float(bal),
        })
    return {"pools": rows, "total": float(total)}


# ---------------------------------------------------------------------------
# 恒等式②：库存占用（只算 STOCK + CREDIT）
# ---------------------------------------------------------------------------

#: 计入库存占用的业务类型。TH=过账型必须排除。
STOCK_TYPES = ("HS", "DFQ")


def inventory_occupied(db: Session) -> Decimal:
    """库存占用 = Σ(BUY) − Σ(SELL.principal)，仅限 HS/DFQ。

    TH提号是过账型：付同行 → 交买家，逐笔即时对冲，不形成库存资产。
    若误计，库存占用会被高估 86,115.88。
    """
    bought = db.query(
        func.coalesce(func.sum(OrderEvent.amount), 0)
    ).join(Order, OrderEvent.order_id == Order.id).filter(
        Order.order_type.in_(STOCK_TYPES),
        OrderEvent.event_type == "BUY",
    ).scalar()

    sold = db.query(
        func.coalesce(func.sum(Order.principal), 0)
    ).filter(Order.order_type.in_(STOCK_TYPES)).scalar()

    return Decimal(bought) - Decimal(sold)


def inventory_health(db: Session, as_of: date | None = None) -> dict:
    """R1 库存健康表。只统计 link_status=LINKED 的订单（V23）。"""
    as_of = as_of or date.today()

    in_stock = db.query(Account).filter(Account.status == "在库").all()
    occupied = sum((a.cost_amount for a in in_stock), start=ZERO)
    expected = sum((a.sale_amount - a.cost_amount for a in in_stock), start=ZERO)

    # 呆滞：入库超过 7 天仍未售出（PRD §2.1 硬约束）
    threshold = as_of.toordinal() - 7
    stale = [
        a for a in in_stock
        if a.buy_date and a.buy_date.toordinal() < threshold
    ]

    # 周转天数：仅统计已关联订单（有 BUY 与 SELL 配对）
    turnover = _turnover_days(db)

    return {
        "in_stock_count": len(in_stock),
        "occupied_principal": float(occupied),
        "expected_profit": float(expected),
        "stale_count": len(stale),
        "stale_principal": float(sum((a.cost_amount for a in stale), start=ZERO)),
        "high_risk_count": sum(1 for a in in_stock if a.risk_level != "NORMAL"),
        "avg_turnover_days": turnover,
        "unlinked_orders": db.query(Order).filter(
            Order.link_status != "LINKED"
        ).count(),
    }


def _turnover_days(db: Session) -> float | None:
    """库存周转天数 = 平均(卖出日 − 买号日)。

    仅统计有 BUY 与 SELL 配对且 link_status=LINKED 的订单。
    历史 89 单无账号关联，返回 None 表示「不可算」，不返回 0。
    """
    pairs = db.query(Order).filter(
        Order.link_status == "LINKED",
        Order.order_type.in_(STOCK_TYPES),
    ).all()

    spans = []
    for o in pairs:
        buy = db.query(OrderEvent).filter(
            OrderEvent.order_id == o.id, OrderEvent.event_type == "BUY"
        ).first()
        sell = db.query(OrderEvent).filter(
            OrderEvent.order_id == o.id, OrderEvent.event_type == "SELL"
        ).first()
        if buy and sell:
            spans.append((sell.occurred_on - buy.occurred_on).days)

    if not spans:
        return None
    return round(sum(spans) / len(spans), 1)


# ---------------------------------------------------------------------------
# 恒等式③：经营损益（全池合并）
# ---------------------------------------------------------------------------

def operating_result(db: Session, year: int | None = None, month: int | None = None) -> Decimal:
    """经营损益 = Σ四类业务利润 + Σ返点 − Σ运营消耗。

    三点必须注意：
    1. 只计 `order_type` 四类主业务（V24）
    2. **返点必须加回**：返点已从 orders 移到 rebate_records（V25），
       但它仍是真实利润。若不计入，会低估利润 1,264.98。
    3. 运营消耗只认 `OPERATING_COST_CATEGORIES` 四类，
       类别名含斜杠（`房租/日用`），不可写成`房租日用`。
    """
    oq = db.query(func.coalesce(func.sum(Order.profit), 0))
    # 返点回加：与订单同期匹配，未归集返点按settled_on 归月
    rq = db.query(func.coalesce(func.sum(RebateRecord.net_amount), 0))
    cq = db.query(func.coalesce(func.sum(CashFlow.amount), 0)).filter(
        CashFlow.nature == "BUSINESS_OUT",
        CashFlow.direction == "支出",
        CashFlow.category.in_(OPERATING_COST_CATEGORIES),
    )
    if year and month:
        ym = f"{year:04d}-{month:02d}"
        oq = oq.filter(func.strftime("%Y-%m", Order.trade_date) == ym)
        rq = rq.filter(func.strftime("%Y-%m", RebateRecord.settled_on) == ym)
        cq = cq.filter(func.strftime("%Y-%m", CashFlow.occurred_on) == ym)

    return Decimal(oq.scalar()) + Decimal(rq.scalar()) - Decimal(cq.scalar())


def monthly_operating_result(db: Session) -> list[dict]:
    """按月经营损益表（R2）。"""
    months = set()
    for (ym,) in db.query(func.strftime("%Y-%m", Order.trade_date)).distinct():
        if ym:
            months.add(ym)
    for (ym,) in db.query(func.strftime("%Y-%m", CashFlow.occurred_on)).distinct():
        if ym:
            months.add(ym)

    rows = []
    running = 0.0
    for ym in sorted(months):
        y, m = ym.split("-")
        profit = float(operating_result(db, int(y), int(m)))
        cumulative = round(running + profit, 2)
        rows.append({"month": ym, "net_profit": round(profit, 2), "cumulative": cumulative})
        running = cumulative
    return rows


# ---------------------------------------------------------------------------
# 恒等式④：权益
# ---------------------------------------------------------------------------

def equity(db: Session) -> dict:
    """权益 = **自有**池余额合计 − 股本。

    关键：只算 ownership=OWNED 的池。
    代客保管 / 平台保证金虽是真实现金，但不属于工作室，
    计入权益会虚高。现金头寸是「手上多少钱」，权益是「其中有多少是自己的」。

    股本 = 自有池的 EXTERNAL_IN 累计（投资款注入）。
    """
    balances = all_pools_balance(db, only_owned=True)
    total = Decimal(str(balances["total"]))

    owned_ids = [p["pool_id"] for p in balances["pools"]] or [-1]
    capital = Decimal(db.query(
        func.coalesce(func.sum(CashFlow.amount), 0)
    ).filter(
        CashFlow.nature == "EXTERNAL_IN",
        CashFlow.pool_id.in_(owned_ids),
    ).scalar())

    result = operating_result(db)
    all_bal = all_pools_balance(db)
    non_owned = Decimal(str(all_bal["total"])) - total
    return {
        "owned_pool_balance": float(total),
        "paid_in_capital": float(capital),
        "operating_result": float(result),
        "equity": float(total - capital),
        "cash_position": float(all_bal["total"]),
        "non_owned_balance": float(non_owned),
        "note": "权益只算自有池；代管资金计入现金头寸但不计入权益",
    }


# ---------------------------------------------------------------------------
# 恒等式⑤：池间划转对称性
# ---------------------------------------------------------------------------

def transfer_symmetry(db: Session) -> dict:
    """校验 INTERNAL 流水是否成对。

    每条 INTERNAL 必须有同 transfer_id 的配对流水（一条收入、一条支出）。
    单边即为数据缺陷（V16）。
    """
    rows = db.query(
        CashFlow.transfer_id,
        func.count(CashFlow.id),
        func.sum(func.iif(CashFlow.direction == "收入", 1, 0)),
        func.sum(func.iif(CashFlow.direction == "支出", 1, 0)),
    ).filter(
        CashFlow.nature == "INTERNAL",
        CashFlow.transfer_id.isnot(None),
    ).group_by(CashFlow.transfer_id).all()

    unpaired = [
        {"transfer_id": tid, "total": total, "in_cnt": inc, "out_cnt": outc}
        for tid, total, inc, outc in rows
        if not (inc and outc)
    ]
    orphans = db.query(func.count(CashFlow.id)).filter(
        CashFlow.nature == "INTERNAL", CashFlow.transfer_id.is_(None)
    ).scalar()

    return {
        "transfer_groups": len(rows),
        "unpaired": unpaired,
        "missing_transfer_id": orphans,
        "balanced": len(unpaired) == 0 and orphans == 0,
    }


# ---------------------------------------------------------------------------
# R5 业务级损益表
# ---------------------------------------------------------------------------

def business_profitability(db: Session) -> dict:
    """R5：按四类业务分组，主业利润 + 附加返点 = 完整收益。

    未归集返点（link_status != LINKED）单列，**不摊入任何业务**。
    """
    out = {"businesses": [], "unlinked_rebate": 0.0}

    for otype, cname, ctype in (
        ("HS", "回收", "STOCK"),
        ("TH", "提号", "PASS_THRU"),
        ("DG", "代挂", "ZERO"),
        ("DFQ", "代分期", "CREDIT"),
    ):
        orders = db.query(Order).filter(Order.order_type == otype).all()
        principal = sum((o.principal for o in orders), start=ZERO)
        profit = sum((o.profit for o in orders), start=ZERO)

        # 只归集 LINKED 返点
        rebate = Decimal(db.query(
            func.coalesce(func.sum(RebateRecord.net_amount), 0)
        ).join(Order, RebateRecord.source_order_id == Order.id).filter(
            Order.order_type == otype,
            RebateRecord.link_status == "LINKED",
        ).scalar())

        total = profit + rebate
        out["businesses"].append({
            "order_type": otype,
            "name": cname,
            "capital_type": ctype,
            "order_count": len(orders),
            "principal": float(principal),
            "main_profit": float(profit),
            "rebate": float(rebate),
            "total_profit": float(total),
            "margin": round(float(total / principal), 4) if principal else None,
        })

    unlinked = Decimal(db.query(
        func.coalesce(func.sum(RebateRecord.net_amount), 0)
    ).filter(RebateRecord.link_status != "LINKED").scalar())
    out["unlinked_rebate"] = float(unlinked)
    out["note"] = "未归集返点不摊入任何业务（宁可显示缺口，不做错误归集）"
    return out


# ---------------------------------------------------------------------------
# 综合自检
# ---------------------------------------------------------------------------

def full_check(db: Session) -> dict:
    """一次性跑全部 5 条恒等式 + 库存健康 + 划转对称性。"""
    balances = all_pools_balance(db)
    return {
        "id1_pool_balance": balances,
        "id2_inventory": {
            "occupied": float(inventory_occupied(db)),
            "limit": 74212.41,
            "pass": float(inventory_occupied(db)) <= 74212.41,
        },
        "id3_operating_result": float(operating_result(db)),
        "id4_equity": equity(db),
        "id5_transfer": transfer_symmetry(db),
        "inventory_health": inventory_health(db),
        "business_profitability": business_profitability(db),
    }
