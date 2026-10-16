"""现金流独立录入审核与冲销字段。

Revision ID: 0039_cashflow_lifecycle
Revises: 0038_policy_scope_key
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text
from sqlalchemy.schema import CreateTable

from app.core.database import Base  # noqa: F401
from app.domain import foundation, history, parties, trade, users  # noqa: F401


revision = "0039_cashflow_lifecycle"
down_revision = "0038_policy_scope_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("PRAGMA foreign_keys=OFF"))
    table = Base.metadata.tables["cashflow"]
    ddl = str(CreateTable(table).compile(dialect=bind.dialect))
    ddl = ddl.replace("CREATE TABLE cashflow (", "CREATE TABLE _new_cashflow (", 1)
    # 0039 的新增审核字段在旧库不存在；旧流水按“业务流水已过账”的事实迁入。
    ddl = ddl.replace(
        "status VARCHAR(16) NOT NULL,",
        "status VARCHAR(16) DEFAULT 'APPROVED' NOT NULL,",
        1,
    )
    bind.execute(text("DROP TABLE IF EXISTS _new_cashflow"))
    bind.execute(text(ddl))
    old_columns = [row[1] for row in bind.execute(text("PRAGMA table_info(cashflow)"))]
    new_columns = [column.name for column in table.columns]
    copied = [column for column in new_columns if column in old_columns]
    missing = [column for column in new_columns if column not in old_columns]
    target_columns = copied + [column for column in missing if column == "status"]
    select_columns = copied + (["'APPROVED'"] if "status" in missing else [])
    columns_sql = ", ".join(target_columns)
    select_sql = ", ".join(select_columns)
    bind.execute(
        text(
            f"INSERT INTO _new_cashflow ({columns_sql}) "
            f"SELECT {select_sql} FROM cashflow"
        )
    )
    bind.execute(text("DROP TABLE cashflow"))
    bind.execute(text("ALTER TABLE _new_cashflow RENAME TO cashflow"))
    for index in table.indexes:
        unique = "UNIQUE " if index.unique else ""
        columns = ", ".join(column.name for column in index.columns)
        bind.execute(
            text(
                f"CREATE {unique}INDEX IF NOT EXISTS {index.name} "
                f"ON cashflow ({columns})"
            )
        )


def downgrade() -> None:
    # 0039 只向前扩展字段；完整回退时由 0002 的表级回退删除 cashflow。
    pass
