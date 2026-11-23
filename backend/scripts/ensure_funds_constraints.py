"""为已有 PostgreSQL 库补齐资金约束；不属于 Alembic 迁移链。

先检查历史数据，发现多个默认账户或工作室押金关联订单时拒绝执行。
调用者必须显式提供 ERP_CONSTRAINT_DATABASE_URL 和 --apply；不读取默认业务库配置。
"""
from __future__ import annotations

import argparse
import os
import re

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection


def _compact(value: str) -> str:
    return re.sub(r"[\s()\"]|::text", "", value).lower()


def ensure_funds_constraints(connection: Connection) -> dict[str, str]:
    if connection.dialect.name != "postgresql":
        raise RuntimeError("资金约束补齐仅支持 PostgreSQL")
    # 与检查和 DDL 同一事务，防止检查后、建约束前出现新的不合法写入。
    connection.execute(text("LOCK TABLE public.pools, public.deposits IN SHARE ROW EXCLUSIVE MODE"))
    defaults = connection.scalar(text("SELECT count(*) FROM public.pools WHERE is_default IS TRUE"))
    invalid_deposits = connection.scalar(text(
        "SELECT count(*) FROM public.deposits WHERE ledger_type = 'STUDIO' AND source_order_id IS NOT NULL"
    ))
    if defaults > 1 or invalid_deposits:
        raise RuntimeError(f"历史数据不符合约束：默认资金账户 {defaults} 个，关联订单的工作室押金 {invalid_deposits} 条")

    constraint = connection.execute(text("""
        SELECT pg_get_constraintdef(oid) AS definition, convalidated
        FROM pg_constraint
        WHERE conrelid = 'public.deposits'::regclass AND conname = 'ck_deposits_studio_deposit_no_order'
    """)).mappings().first()
    index = connection.execute(text("""
        SELECT indisunique, indisvalid, indnkeyatts, indnatts,
               pg_get_indexdef(indexrelid, 1, true) AS column_name,
               pg_get_expr(indpred, indrelid) AS predicate
        FROM pg_index WHERE indexrelid = to_regclass('public.uq_pools_single_default')
    """)).mappings().first()
    if constraint and (not constraint["convalidated"] or _compact(constraint["definition"]) != "checkledger_type<>'studio'orsource_order_idisnull"):
        raise RuntimeError("现有工作室押金约束定义不一致，请先核对")
    if index and not (
        index["indisunique"] and index["indisvalid"] and index["indnkeyatts"] == 1
        and index["indnatts"] == 1 and index["column_name"] == "is_default"
        and _compact(index["predicate"] or "") == "is_defaultistrue"
    ):
        raise RuntimeError("现有默认资金账户索引定义不一致，请先核对")

    if constraint is None:
        connection.execute(text("""
            ALTER TABLE public.deposits ADD CONSTRAINT ck_deposits_studio_deposit_no_order
            CHECK (ledger_type <> 'STUDIO' OR source_order_id IS NULL)
        """))
    if index is None:
        connection.execute(text("""
            CREATE UNIQUE INDEX uq_pools_single_default ON public.pools (is_default) WHERE is_default IS TRUE
        """))
    return {
        "default_pool_index": "present" if index else "created",
        "studio_deposit_check": "present" if constraint else "created",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="对明确指定的数据库执行检查和补齐")
    args = parser.parse_args()
    url = os.environ.get("ERP_CONSTRAINT_DATABASE_URL")
    if not args.apply or not url:
        parser.error("必须显式提供 --apply 和 ERP_CONSTRAINT_DATABASE_URL")
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            result = ensure_funds_constraints(connection)
        print(f"资金约束检查完成：{result}")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
