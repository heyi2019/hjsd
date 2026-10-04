"""core.money：金额工具 + DECIMAL(18,2) 列类型。

规则（PRD §6.1 / 功能规格 §1.3.1）：
- 金额一律 `Decimal` / `DECIMAL(18,2)`，**禁止 float 参与业务计算**；
- 只在“与数据库交互的最后一厘米”做底层精度换算，业务层永远看到 2 位量化 Decimal。
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import Numeric
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator

QUANT = Decimal("0.01")
ZERO = Decimal("0.00")
PRECISION = 18
SCALE = 2


def to_money(value: Any, *, field: str = "amount") -> Decimal:
    """把任意输入安全转为 2 位 Decimal。

    拒绝 NaN/Inf/布尔/非数字；float 输入先经 str() 再 Decimal，避免二进制尾差被放大。
    """
    if value is None:
        raise ValueError(f"{field} 不能为空")
    if isinstance(value, bool):
        raise ValueError(f"{field} 不能为布尔值")
    try:
        raw = value if isinstance(value, Decimal) else Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError) as error:
        raise ValueError(f"{field} 不是合法金额") from error
    if not raw.is_finite():
        raise ValueError(f"{field} 必须为有限数值")
    quantized = raw.quantize(QUANT, rounding=ROUND_HALF_UP)
    # 归一化负零：-0.00 不应出现在账面上
    if quantized == 0:
        return Decimal("0.00")
    return quantized


def parse_amount(value: Any) -> Decimal:
    """向后兼容的别名（legacy 代码在用），语义同 to_money。"""
    return to_money(value)


def require_positive(value: Any, *, field: str = "amount") -> Decimal:
    """V3：金额为 0 不得入库。"""
    amount = to_money(value, field=field)
    if amount <= ZERO:
        raise ValueError(f"{field} 必须大于 0")
    return amount


def require_non_negative(value: Any, *, field: str = "amount") -> Decimal:
    amount = to_money(value, field=field)
    if amount < ZERO:
        raise ValueError(f"{field} 不能为负数")
    return amount


def sum_amounts(values: Any) -> Decimal:
    """多笔金额求和：空序列返回 0.00，杜绝 None 传播。"""
    total = ZERO
    for value in values:
        total += to_money(value)
    return total.quantize(QUANT)


def money_equal(left: Any, right: Any, *, tolerance: Decimal = Decimal("0.0001")) -> bool:
    """财务容差比较，仅用于报表勾稽，不用于业务判定。"""
    return abs(to_money(left) - to_money(right)) <= tolerance


class Amount(TypeDecorator):
    """DECIMAL(18,2) 金额列：对外恒为 Decimal。

    SQLite 无原生定点类型，底层以双精度 REAL 存储，因此：
    - 写入：Decimal -> float 落库；
    - 读出：立即 `Decimal(str(value))` 并量化到 2 位。
    在 18,2 的实际业务量级（远低于 1e13）内往返无损；迁 PostgreSQL 后自动退化为原生 NUMERIC。
    """

    impl = Numeric(PRECISION, SCALE, asdecimal=True)
    cache_ok = True

    @property
    def python_type(self) -> type[Decimal]:  # type: ignore[override]
        return Decimal

    def process_bind_param(self, value: Any, dialect: Dialect) -> float | None:
        if value is None:
            return None
        return float(to_money(value))

    def process_result_value(self, value: Any, dialect: Dialect) -> Decimal | None:
        if value is None:
            return None
        return to_money(value)


__all__ = [
    "PRECISION",
    "QUANT",
    "SCALE",
    "ZERO",
    "Amount",
    "money_equal",
    "parse_amount",
    "require_non_negative",
    "require_positive",
    "sum_amounts",
    "to_money",
]
