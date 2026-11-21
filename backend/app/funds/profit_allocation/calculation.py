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
