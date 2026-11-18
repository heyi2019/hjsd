"""分期建档的纯计算与金额守卫：计划/费率/期次/金额，不含任何 session 写入。"""
from __future__ import annotations

from typing import Any
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.money import to_money
from app.installments.schemas import ScheduleCreate
from app.installments._shared import _non_negative
from app.shared.order_amounts import order_amounts

def sale_installment_plan(
    *,
    sale_amount: Any,
    down_payment: Any = 0,
    service_fee: Any = 0,
    periods: int,
    per_period: Any = None,
) -> dict[str, Any]:
    """Calculate the stock-sale installment plan using Decimal money values."""
    sale = _non_negative(sale_amount, field="sale_amount")
    down = _non_negative(down_payment, field="down_payment")
    fee = _non_negative(service_fee, field="service_fee")
    if periods <= 0:
        raise Validation("期数必须大于 0", details={"field": "periods", "value": periods})
    if down > sale:
        raise Validation("首付不能超过售出金额", details={"field": "down_payment"})
    base = sale - down
    total = base + fee
    suggested = (total / Decimal(periods)).quantize(Decimal("0.01"), rounding=ROUND_CEILING)
    supplied = None if per_period is None else _non_negative(per_period, field="per_period")
    effective = suggested if supplied is None else supplied
    last = total - effective * (periods - 1)
    return {
        "principal": sale,
        "down_payment": down,
        "service_fee": fee,
        "periods": periods,
        "base_amount": base,
        "total_schedule_amount": total,
        "per_period": suggested,
        "last_period": last,
        "per_period_service_fee": (fee / Decimal(periods)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        "per_period_matches": None if supplied is None else (
            supplied * periods >= base and supplied * (periods - 1) <= total
        ),
    }


def _normalize_schedule(schedule: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not schedule:
        return []
    try:
        return [
            item.model_dump()
            for item in (ScheduleCreate.model_validate(raw) for raw in schedule)
        ]
    except PydanticValidationError as exc:
        raise Validation(
            "分期计划字段校验失败",
            details={
                "field": "schedule",
                "errors": [
                    {
                        "field": ".".join(str(part) for part in error["loc"]),
                        "message": error["msg"],
                    }
                    for error in exc.errors()
                ],
            },
        ) from exc


def _service_fee_from_snapshot(
    session: Session,
    snapshot: dict[str, Any] | None,
    order: Any,
    principal: Decimal,
) -> Decimal:
    """按 INSTALLMENT 规则补算服务费（仅在入参 service_fee 省略时调用）。

    - 规则没有 service_fee_rate：返回 0，保持「不收服务费」的既有默认。
    - 基数 config.base：PRINCIPAL（默认）取本金；GROSS 取订单卖出收入合计；
      其它值直接报错，不静默回退——「配了却按别的基数算钱」比报错更危险。
    """
    if not snapshot:
        return Decimal("0")
    config = snapshot.get("config")
    if not isinstance(config, dict):
        return Decimal("0")
    raw_rate = config.get("service_fee_rate")
    if raw_rate is None:
        return Decimal("0")
    try:
        rate = to_money(raw_rate)
    except ValueError as exc:
        raise Validation(
            "分期规则中的服务费率必须是数值",
            details={"field": "config.service_fee_rate", "value": str(raw_rate)},
        ) from exc
    if rate > Decimal("100.00"):
        raise Validation(
            "分期服务费率必须在 0% 到 100% 之间",
            details={"field": "config.service_fee_rate", "value": str(rate)},
        )
    base_kind = str(config.get("base") or "PRINCIPAL").strip().upper()
    if base_kind == "PRINCIPAL":
        base = principal
    elif base_kind == "GROSS":
        base = order_amounts(session, order.id)["GROSS"]
    else:
        raise Validation(
            f"分期服务费基数不支持 {base_kind}（仅 PRINCIPAL / GROSS）",
            details={"field": "config.base", "value": base_kind},
        )
    return (base * rate / Decimal("100")).quantize(Decimal("0.01"))


def _assert_installment_amounts(
    *,
    down_payment_amount: Decimal,
    principal_amount: Decimal,
    total_schedule_amount: Decimal,
    service_fee_amount: Decimal,
    per_period_amount: Decimal,
    adjust_final_period: bool,
) -> Decimal:
    """分期金额三条守卫：首付≤本金≤分期总额、末期调整不为负。返回末期调整额。"""
    if down_payment_amount > principal_amount:
        raise Validation(
            "首付不能大于本金",
            details={
                "field": "down_payment",
                "down_payment": str(down_payment_amount),
                "principal": str(principal_amount),
            },
        )
    if principal_amount > total_schedule_amount:
        raise Validation(
            "本金不能大于首付与分期总额",
            details={
                "field": "principal",
                "principal": str(principal_amount),
                "maximum": str(total_schedule_amount),
            },
        )

    adjustment = principal_amount + service_fee_amount - total_schedule_amount if adjust_final_period else Decimal("0")
    if per_period_amount + adjustment < 0:
        raise Validation("每期金额过高，最后一期金额不能为负数", details={"field": "per_period"})
    return adjustment
