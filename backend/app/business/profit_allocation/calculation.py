"""分润明细金额与尾差的共享计算。"""
from __future__ import annotations

from decimal import Decimal, ROUND_DOWN

from app.core.money import to_money_or_zero
from app.domain.trade import OrderProfitAllocation


def allocation_bases(rows: list[OrderProfitAllocation], profit: Decimal) -> dict[int, Decimal]:
    """同一订单先统一分配尾差，再按人员筛选，确保各视图金额一致。"""
    fixed: dict[int, Decimal] = {}
    raw_rates: dict[int, Decimal] = {}
    for row in rows:
        amount = to_money_or_zero(row.allocation_amount)
        if amount != 0:
            fixed[row.id] = amount
        else:
            raw_rates[row.id] = profit * to_money_or_zero(row.allocation_rate) / Decimal("100")
    rounded = {key: value.quantize(Decimal("0.01"), rounding=ROUND_DOWN) for key, value in raw_rates.items()}
    fixed_total = sum(fixed.values(), Decimal("0"))
    target = (fixed_total + sum(raw_rates.values(), Decimal("0"))).quantize(Decimal("0.01")) - fixed_total
    cents = int((target - sum(rounded.values(), Decimal("0"))) * 100)
    if cents:
        direction = Decimal("0.01") if cents > 0 else Decimal("-0.01")
        candidates = sorted(
            (key for key, value in raw_rates.items() if value * direction > 0),
            key=lambda key: (-(abs(raw_rates[key]) - abs(rounded[key])), key),
        )
        for key in candidates[:abs(cents)]:
            rounded[key] += direction
    return {**fixed, **rounded}


def _proportional(total: Decimal, weights: dict[int, Decimal]) -> dict[int, Decimal]:
    """按权重分配到分，尾差按余数和行 ID 确定。"""
    weight_sum = sum(weights.values(), Decimal(0))
    if not weight_sum:
        return {key: Decimal('0.00') for key in weights}
    raw = {key: total * weight / weight_sum for key, weight in weights.items()}
    result = {key: value.quantize(Decimal('0.01'), rounding=ROUND_DOWN) for key, value in raw.items()}
    cents = int((total - sum(result.values(), Decimal(0))) * 100)
    direction = Decimal('0.01') if cents > 0 else Decimal('-0.01')
    for key in sorted(raw, key=lambda key: (-(abs(raw[key]) - abs(result[key])), key))[:abs(cents)]:
        result[key] += direction
    return result


def effective_distribution(rows: list[OrderProfitAllocation], profit: Decimal, company_rate: Decimal) -> tuple[list[OrderProfitAllocation], dict[int, Decimal], dict[int, Decimal]]:
    """以历史人员配置为权重应用当前公司比例，不改写原始分润记录。"""
    from decimal import ROUND_HALF_UP

    if not rows:
        return [], {}, {}
    companies = [row for row in rows if row.allocation_type == 'COMPANY' or (row.allocation_type is None and row.user_id is None)]
    staff = [row for row in rows if row not in companies]
    if not companies:
        company = OrderProfitAllocation(id=-rows[0].order_id, order_id=rows[0].order_id, user_id=None, role='OWNER', allocation_type='COMPANY', allocation_rate=0, allocation_amount=0)
        companies = [company]
        rows = [*rows, company]
    original = allocation_bases(rows, profit)
    def weights(group: list[OrderProfitAllocation]) -> dict[int, Decimal]:
        values = {row.id: abs(original[row.id]) for row in group}
        if not sum(values.values(), Decimal(0)):
            values = {row.id: abs(to_money_or_zero(row.allocation_amount)) or abs(to_money_or_zero(row.allocation_rate)) for row in group}
        return values
    company_weights = weights(companies)
    if not sum(company_weights.values(), Decimal(0)):
        company_weights[companies[0].id] = Decimal(1)
    personnel_pool = (profit * (Decimal(100) - company_rate) / Decimal(100)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    staff_weights = weights(staff)
    # 旧配置允许只分配一部分；保留未分配的份额，不能擅自分给现有人员。
    old_company = sum((abs(original[row.id]) for row in companies), Decimal(0))
    old_pool = max(abs(profit) - old_company, Decimal(0))
    assigned = sum(staff_weights.values(), Decimal(0))
    fraction = min(assigned / old_pool, Decimal(1)) if old_pool else (Decimal(1) if assigned else Decimal(0))
    allocated_pool = (personnel_pool * fraction).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    allocated_rate = ((Decimal(100) - company_rate) * fraction).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    amounts = {**_proportional(profit - personnel_pool, company_weights), **_proportional(allocated_pool, staff_weights)}
    rates = {**_proportional(company_rate, company_weights), **_proportional(allocated_rate, staff_weights)}
    return rows, amounts, rates
