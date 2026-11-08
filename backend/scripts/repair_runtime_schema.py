"""修复存量 PostgreSQL 与当前 ORM 的已知结构漂移。

当前版本已经删除了资金性质、资金流向性质和订单资金分类字段。压平后的
``0001`` 基线只会对新表执行 ``create_all``，不会改造已存在的表；存量库若
仍保留这些非空列，SQLAlchemy 的新写入会在 flush 时被 PostgreSQL 拒绝，
最终表现为建单接口 500。

本脚本只做幂等、明确列出的兼容清理，不做通用自动删列。部署启动前执行一次，
因此旧库和新库都能安全通过；业务数据不受影响。
"""
from __future__ import annotations

from sqlalchemy import text

from app.core.database import build_engine


_RETIRED_COLUMN_STATEMENTS = (
    'ALTER TABLE public."order_type_defs" DROP COLUMN IF EXISTS capital_type CASCADE',
    'ALTER TABLE public."orders" DROP COLUMN IF EXISTS capital_type CASCADE',
    'ALTER TABLE public."order_type_pools" DROP COLUMN IF EXISTS fund_nature CASCADE',
    'ALTER TABLE public."cashflow" DROP COLUMN IF EXISTS fund_nature CASCADE',
    'ALTER TABLE public."cashflow" DROP COLUMN IF EXISTS nature CASCADE',
)

_ACCOUNTING_ATTRIBUTE_STATEMENT = (
    'ALTER TABLE public."cashflow" ADD COLUMN IF NOT EXISTS accounting_attribute '
    "VARCHAR(32) NOT NULL DEFAULT 'EXPENSE'"
)


def repair_runtime_schema(engine) -> None:
    """把已知的旧版非空字段清掉，并保证当前现金流写入列存在。"""
    with engine.begin() as connection:
        for statement in _RETIRED_COLUMN_STATEMENTS:
            connection.execute(text(statement))
        connection.execute(text(_ACCOUNTING_ATTRIBUTE_STATEMENT))


def main() -> None:
    engine = build_engine()
    try:
        repair_runtime_schema(engine)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
