"""删除 cashflow 旧核算属性字段（PostgreSQL）。

该脚本只删除分类列、索引和约束，不改写流水金额、方向、资金账户、订单关联或明细。
执行前请备份数据库；执行后需重新检查 ORM 与数据库结构一致性。
"""
from __future__ import annotations

import argparse
import os

from sqlalchemy import create_engine, text


def remove(database_url: str) -> list[str]:
    engine = create_engine(database_url)
    actions: list[str] = []
    with engine.begin() as connection:
        exists = connection.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() "
                "AND table_name = 'cashflow' AND column_name = 'accounting_attribute'"
            )
        ).scalar()
        if exists:
            connection.execute(text("ALTER TABLE cashflow DROP COLUMN accounting_attribute"))
            actions.append("删除 cashflow.accounting_attribute")

        for index_name in ("ix_cashflow_accounting_attribute",):
            connection.execute(text(f"DROP INDEX IF EXISTS {index_name}"))
            actions.append(f"删除索引 {index_name}")

        connection.execute(
            text("DELETE FROM option_sets WHERE code = 'FUND_FLOW_ACCOUNTING_ATTRIBUTE'")
        )
        connection.execute(
            text(
                "DELETE FROM order_form_fields "
                "WHERE order_type_code = 'FUNDFLOW' "
                "AND field_key = 'accounting_attribute'"
            )
        )
    engine.dispose()
    return actions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    args = parser.parse_args()
    if not args.database_url:
        raise SystemExit("请通过 --database-url 或 DATABASE_URL 指定 PostgreSQL 数据库")
    for action in remove(args.database_url):
        print(f"[remove_cashflow_accounting_attribute] {action}")
    print("[remove_cashflow_accounting_attribute] OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
