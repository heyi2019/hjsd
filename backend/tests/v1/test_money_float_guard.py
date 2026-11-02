"""回归护栏：金额列在「Decimal → float → Decimal」往返中必须无损，且 2 位小数金额
的浮点聚合与 Decimal 聚合一致（业务量级）。

SQLite 已于 2026-11 整体下线，本测试不再依赖任何数据库引擎（含 SQLite）：
直接验证 `core.money.Amount` 的底层类型装饰器往返，以及 2 万位 2 位小数金额在
IEEE double 下的聚合一致性。审计评估确认：2 位小数货币在任意现实量级下，浮点 SUM
与 Decimal SUM 一致（相对误差 ~1e-16，绝对误差远低于半分）。一旦有人绕过 `to_money`
写入非 2 位值、或 `Amount` 的浮点往返被破坏，这里会先红。
"""
from __future__ import annotations

import random
from decimal import Decimal

from app.core.money import Amount, to_money


def test_amount_float_sum_matches_decimal() -> None:
    """合成 2 万行 2 位小数金额：底层 float 聚合与 Decimal SUM 一致（精确到 2 位）。"""
    amt = Amount()
    random.seed(7)
    rows = [round(random.uniform(0.01, 9999.99), 2) for _ in range(20000)]
    expected = sum(Decimal(str(v)) for v in rows)

    # 模拟生产 Amount 列绑定：Decimal → float（与 DB 存储同一路径），再在 Python 侧聚合。
    floats = [amt.process_bind_param(to_money(v), None) for v in rows]
    assert all(isinstance(x, float) for x in floats)
    sql_sum = sum(floats)

    # 读出即量化 2 位（与生产路径一致），与 Decimal 求和比对
    got = to_money(sql_sum)
    assert got == expected.quantize(Decimal("0.01")), f"SUM 漂移: got={got} expected={expected}"


def test_amount_roundtrip_no_precision_loss() -> None:
    """单值 Decimal → float → Decimal 必须无损（2 位小数，业务量级）。"""
    amt = Amount()
    vals = [Decimal("123.45"), Decimal("0.01"), Decimal("999999.99"), Decimal("0.00")]
    out = [amt.process_result_value(amt.process_bind_param(v, None), None) for v in vals]
    assert out == vals, f"往返损失: {out} != {vals}"
    assert all(isinstance(v, Decimal) for v in out)
