"""统一数据库时间精度：保存到秒，前端负责按分钟展示。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def _quote(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    is_postgres = bind.dialect.name == "postgresql"

    for table in inspector.get_table_names():
        quoted_table = _quote(table)
        for column in inspector.get_columns(table):
            if not isinstance(column["type"], sa.DateTime):
                continue
            name = column["name"]
            quoted_column = _quote(name)
            if is_postgres:
                bind.execute(
                    sa.text(
                        f"UPDATE {quoted_table} "
                        f"SET {quoted_column} = date_trunc('second', {quoted_column}) "
                        f"WHERE {quoted_column} IS NOT NULL"
                    )
                )
            else:
                bind.execute(
                    sa.text(
                        f"UPDATE {quoted_table} "
                        f"SET {quoted_column} = datetime({quoted_column}) "
                        f"WHERE {quoted_column} IS NOT NULL"
                    )
                )

            # ORM 外的直接插入也要遵守秒级精度；只给已有时间戳默认列设置默认值。
            if is_postgres and name in {"created_at", "updated_at", "inventory_entry_at", "occurred_at"}:
                bind.execute(
                    sa.text(
                        f"ALTER TABLE {quoted_table} "
                        f"ALTER COLUMN {quoted_column} SET DEFAULT CURRENT_TIMESTAMP(0)"
                    )
                )


def downgrade() -> None:
    # 精度归一化不可逆；保留字段和数据，不做破坏性回滚。
    pass
