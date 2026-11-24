"""允许旧库的新附件不再填写历史编号；保留历史值与既有唯一约束。

此操作不属于 Alembic 活动链。必须显式指定目标连接并传入 --apply。
"""
from __future__ import annotations

import argparse
import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection


def relax_attachment_number(connection: Connection) -> bool:
    if connection.dialect.name != "postgresql":
        raise RuntimeError("附件历史字段调整仅支持 PostgreSQL")
    not_null = connection.execute(text("""
        SELECT attnotnull FROM pg_attribute
        WHERE attrelid = to_regclass('public.attachments')
          AND attname = 'attachment_no' AND NOT attisdropped
    """)).scalar_one_or_none()
    if not_null is None:
        raise RuntimeError("未找到附件历史编号字段，请先核对数据库结构")
    if not not_null:
        return False
    connection.execute(text("SET LOCAL lock_timeout = '5s'"))
    connection.execute(text("ALTER TABLE public.attachments ALTER COLUMN attachment_no DROP NOT NULL"))
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="对明确指定的数据库执行调整")
    args = parser.parse_args()
    url = os.environ.get("ERP_ATTACHMENT_SCHEMA_DATABASE_URL")
    if not args.apply or not url:
        parser.error("必须显式提供 --apply 和 ERP_ATTACHMENT_SCHEMA_DATABASE_URL")
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            changed = relax_attachment_number(connection)
        print("附件历史编号字段已允许为空" if changed else "附件历史编号字段已允许为空，无需调整")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
