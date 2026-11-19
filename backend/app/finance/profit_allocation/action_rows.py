"""按动作分润：表单分组行 → 按人分配记录的展开与校验（纯函数，无 DB 访问）。

从 service.py 拆出（2026-11-18）。两种录入口径见 service.set_allocations 文档。
"""
from __future__ import annotations

from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from typing import Any

from app.core.errors import Validation
from app.core.money import to_money

ACTION_TYPES = {"BUY", "SELL", "OPERATION", "COMPANY"}


def _split_even(value: Decimal, count: int, *, scale: Decimal) -> list[Decimal]:
    units = (value * scale).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    base = (units / count).to_integral_value(rounding=ROUND_DOWN)
    parts = [base for _ in range(count)]
    parts[-1] += units - base * count
    return [part / scale for part in parts]


def expand_action_form_rows(
    rows: list[dict[str, Any]], *, order_profit: Decimal, company_rate: Decimal
) -> list[dict[str, Any]]:
    """Validate grouped UI rows and expand them into per-person allocation records."""
    if not any(str(row.get("allocation_type") or "").upper() == "COMPANY" for row in rows):
        rows = [
            *rows,
            {
                "allocation_type": "COMPANY",
                "role": "OWNER",
                "allocation_rate": str(company_rate),
                "allocation_amount": None,
            },
        ]
    # 金额模式下公司仍按规则固定占比，转换为公司金额参与同一金额口径校验；
    # 否则隐藏的公司比例会和动作金额混成两种口径，落库时公司份额被清零。
    has_action_amount = any(
        str(row.get("allocation_amount") or "").strip()
        for row in rows
        if str(row.get("allocation_type") or "").upper() != "COMPANY"
    )
    if has_action_amount:
        company_amount = (order_profit * company_rate / Decimal("100")).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        rows = [
            (
                {
                    **row,
                    "allocation_rate": None,
                    "allocation_amount": str(company_amount),
                }
                if str(row.get("allocation_type") or "").upper() == "COMPANY"
                and not str(row.get("allocation_amount") or "").strip()
                else row
            )
            for row in rows
        ]
    required = {"BUY", "SELL", "OPERATION", "COMPANY"}
    by_type: dict[str, dict[str, Any]] = {}
    for row in rows:
        kind = str(row.get("allocation_type") or "").upper()
        if kind not in required:
            raise Validation("分润配置只允许买号、售出、运营、公司四项")
        if kind in by_type:
            raise Validation("分润配置每项只能有一行")
        by_type[kind] = row
    if set(by_type) != required:
        raise Validation("分润配置必须包含买号、售出、运营、公司四项")

    parsed: dict[str, dict[str, Any]] = {}
    rate_total = Decimal("0")
    amount_total = Decimal("0")
    has_rate_only = has_amount_only = False
    for kind, row in by_type.items():
        rate_text = "" if row.get("allocation_rate") is None else str(row.get("allocation_rate")).strip()
        amount_text = "" if row.get("allocation_amount") is None else str(row.get("allocation_amount")).strip()
        rate = to_money(rate_text or 0)
        amount = to_money(amount_text or 0)
        has_rate = bool(rate_text)
        has_amount = bool(amount_text)
        if not has_rate and not has_amount:
            raise Validation(f"{kind} 请填写比例或金额")
        if rate < 0 or rate > 100:
            raise Validation(f"{kind} 比例必须在 0% 到 100% 之间")
        has_rate_only = has_rate_only or (has_rate and not has_amount)
        has_amount_only = has_amount_only or (has_amount and not has_rate)
        rate_total += rate
        amount_total += amount
        people = [] if kind == "COMPANY" else list(dict.fromkeys(row.get("employee_ids") or []))
        if kind == "COMPANY" and row.get("employee_ids"):
            raise Validation("公司收益不绑定人员")
        if kind == "OPERATION" and not people:
            raise Validation("运营收益必须绑定人员")
        parsed[kind] = {"row": row, "rate": rate, "amount": amount, "people": people}

    if has_rate_only and has_amount_only:
        raise Validation("同一单的四项要么都按比例、要么都按金额，不能混填")
    use_rate = abs(rate_total - Decimal("100")) <= Decimal("0.001") or amount_total == 0
    if use_rate:
        if abs(rate_total - Decimal("100")) > Decimal("0.001"):
            raise Validation(f"四项比例合计必须为 100%，当前 {rate_total}%")
    else:
        if order_profit > 0 and amount_total < 0:
            raise Validation("该单为盈利单，分润金额不能为负数")
        if order_profit < 0 and amount_total > 0:
            raise Validation("该单为亏损单，分润金额必须填负数（亏损分担额）")
        if order_profit == 0:
            raise Validation("该单利润为 0，按金额分润只能填 0，请改用比例")
        if abs(amount_total) > abs(order_profit):
            raise Validation(f"分润金额合计不能超过订单总利润 {order_profit}")

    expanded: list[dict[str, Any]] = []
    for kind, item in parsed.items():
        row = item["row"]
        people = item["people"] or [None]
        values = _split_even(item["rate"], len(people), scale=Decimal("100")) if use_rate else [Decimal("0")] * len(people)
        amounts = _split_even(item["amount"], len(people), scale=Decimal("100")) if not use_rate else [Decimal("0")] * len(people)
        for index, person_id in enumerate(people):
            expanded.append({
                "user_id": person_id,
                "role": row.get("role") or "OWNER",
                "allocation_type": kind,
                "allocation_rate": values[index],
                "allocation_amount": amounts[index],
            })
    return expanded


__all__ = ["ACTION_TYPES", "expand_action_form_rows"]
