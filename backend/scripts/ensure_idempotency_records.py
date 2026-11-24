"""为已初始化的 PostgreSQL 库补齐资金写入幂等记录表。"""
from __future__ import annotations

import argparse
import re

from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.database import get_engine
from app.core.settings import get_settings
from app.domain.foundation import IdempotencyRecord


def drill_database_url(base: str, name: str) -> str:
    url = make_url(base)
    if (not re.fullmatch(r"heijin_erp_drill_[0-9a-f]{20}", name)
            or url.get_backend_name() != "postgresql"
            or url.host not in {"127.0.0.1", "localhost", "::1"}
            or url.port != 5433 or url.database != "heijin_erp_dev" or url.query):
        raise ValueError("演练补表只允许本机 5433 上的指定临时库")
    return url.set(database=name).render_as_string(hide_password=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="对当前 DATABASE_URL 补表")
    parser.add_argument("--drill-db", help="仅对本机隔离演练库补表")
    args = parser.parse_args()
    if not args.apply:
        parser.error("请核对目标数据库后使用 --apply")

    target = drill_database_url(get_settings().database_url, args.drill_db) if args.drill_db else None
    engine = get_engine(target)
    with engine.begin() as connection:
        connection.execute(text("SELECT pg_advisory_xact_lock(hashtext('heijin:idempotency_records'))"))
        IdempotencyRecord.__table__.create(connection, checkfirst=True)
    print("资金写入幂等记录表已就绪")


if __name__ == "__main__":
    main()
