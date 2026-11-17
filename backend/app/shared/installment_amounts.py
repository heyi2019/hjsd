"""shared.installment_amounts：分期总应收口径（全站唯一公式）。

原在 `app/value_added_services/_shared.py::total_receivable`，被 value_added_services
与 parties 两个域直接引用。放在 vas 下导致 parties 反向依赖 vas
（形成 `parties ↔ value_added_services` 双向环）。

归位理由（满足 shared 层三条判据）：
1. 被 ≥2 个业务域直接引用；
2. 自身不属于任何单一域——它是「分期应收怎么算」的纯公式；
3. 只依赖 core（to_money）与标准库，不依赖任何业务域。

**口径红线**：总应收 = 首付 + 每期 × 期数 + 末期调整 − 减免。
调用方既可以是 `Installment` ORM 实体，也可以是 `InstallmentOut` 输出模型；
两侧不得再各自复制公式，否则口径漂移。
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Protocol

from app.core.money import to_money


class ReceivableLike(Protocol):
    """总应收公式依赖的最小字段集：ORM 实体与 Pydantic 输出模型都满足。"""

    down_payment: Any
    per_period: Any
    periods: int
    final_period_adjustment: Any
    waived_amount: Any


def total_receivable(installment: ReceivableLike) -> Decimal:
    """总应收 = 首付 + 每期 × 期数 + 末期调整 − 减免（全站唯一口径）。"""
    return (
        to_money(installment.down_payment)
        + to_money(installment.per_period) * int(installment.periods)
        + to_money(installment.final_period_adjustment or 0)
        - to_money(installment.waived_amount)
    )


__all__ = ["ReceivableLike", "total_receivable"]
