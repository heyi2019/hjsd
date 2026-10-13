"""回归护栏：金额列 float 存储下，SQL 浮点 SUM 必须 == Decimal SUM（2 位小数、业务量级）。

背景：`core.money.Amount` 写入时 `Decimal → float`（SQLite REAL），读出时
`Decimal(str(float))` 量化回 2 位（`app/core/money.py:93-101`）。审计评估确认：
2 位小数货币在任意现实量级下，浮点 `SUM` 与 `Decimal` `SUM` 一致（IEEE double 相对误差
~1e-16，绝对误差远低于半分）。本测试固化该不变量——一旦有人绕过 `to_money` 写入非 2 位值、
或 `Amount` 的浮点往返被破坏，这里会先红。
"""
from __future__ import annotations

import random
from decimal import Decimal

import pytest
from sqlalchemy import Column, Integer, MetaData, Table, create_engine, func, insert, select
from sqlalchemy.orm import Session

from app.core.money import Amount, to_money


def _build_table(name: str) -> Table:
    meta = MetaData()
    return Table(
        name,
        meta,
        Column("id", Integer, primary_key=True),
        Column("amt", Amount()),
    )


def test_amount_float_sum_matches_decimal() -> None:
    """合成 2 万行 2 位小数金额：SQL 浮点 SUM 与 Decimal SUM 一致（精确到 2 位）。"""
    eng = create_engine("sqlite://")
    t = _build_table("money_guard")
    t.metadata.create_all(eng)

    random.seed(7)
    rows = [round(random.uniform(0.01, 9999.99), 2) for _ in range(20000)]
    expected = sum(Decimal(str(v)) for v in rows)

    with Session(eng) as s:
        # 写入走真实 Amount 绑定逻辑（Decimal → float）
        s.execute(insert(t), [{"amt": to_money(v)} for v in rows])
        s.commit()
        # SQL 层聚合（与生产 reporting/orders/finance 的 func.sum 同一路径）
        sql_sum = s.execute(select(func.sum(t.c.amt))).scalar()

    # 读出即量化 2 位（与生产路径一致），与 Decimal 求和比对
    got = to_money(sql_sum)
    assert got == expected.quantize(Decimal("0.01")), f"SUM 漂移: got={got} expected={expected}"


def test_amount_roundtrip_no_precision_loss() -> None:
    """单值 Decimal → float → Decimal 必须无损（2 位小数）。"""
    eng = create_engine("sqlite://")
    t = _build_table("money_roundtrip")
    t.metadata.create_all(eng)

    vals = [Decimal("123.45"), Decimal("0.01"), Decimal("999999.99"), Decimal("0.00")]
    with Session(eng) as s:
        s.execute(insert(t), [{"amt": to_money(v)} for v in vals])
        s.commit()
        out = s.execute(select(t.c.amt).order_by(t.c.id)).scalars().all()

    assert out == vals, f"往返损失: {out} != {vals}"
