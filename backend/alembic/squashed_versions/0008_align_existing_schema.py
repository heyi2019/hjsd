"""对齐既有 dev 库与当前 ORM schema。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0008_align_existing_schema"
down_revision = "0007_sync_audit_action_option_set"
branch_labels = None
depends_on = None


def _column_is_nullable(bind: sa.Connection, table_name: str, column_name: str) -> bool:
    column = next(
        item
        for item in sa.inspect(bind).get_columns(table_name)
        if item["name"] == column_name
    )
    return bool(column["nullable"])


def _make_timestamp_required(bind: sa.Connection, table_name: str) -> None:
    if not _column_is_nullable(bind, table_name, "created_at"):
        return
    missing = bind.execute(
        sa.text(f"SELECT COUNT(*) FROM {table_name} WHERE created_at IS NULL")
    ).scalar_one()
    if missing:
        raise RuntimeError(
            f"无法将 {table_name}.created_at 设为 NOT NULL：仍有 {missing} 条记录为空"
        )
    op.alter_column(
        table_name,
        "created_at",
        existing_type=sa.DateTime(),
        nullable=False,
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 分次结算模型已下线。该表在当前业务中没有合法写入路径；只有确认为空时才删除，
    # 防止把尚未迁移的历史数据静默丢掉。
    if "rebate_settlements" in inspector.get_table_names():
        row_count = bind.execute(sa.text("SELECT COUNT(*) FROM rebate_settlements")).scalar_one()
        if row_count:
            raise RuntimeError(
                "rebate_settlements 仍包含历史数据，迁移已停止；请先完成数据迁移后再重试"
            )
        op.drop_table("rebate_settlements")

    # 压平前的正式库可能已将版本戳推进到 0007，但 cashflow 仍缺少当前
    # ORM 必需的 fund_nature 列。先补齐列、回填历史行并收紧约束，再创建索引。
    cashflow_columns = {item["name"] for item in inspector.get_columns("cashflow")}
    if "fund_nature" not in cashflow_columns:
        op.execute(
            "ALTER TABLE cashflow ADD COLUMN fund_nature VARCHAR(16) "
            "DEFAULT 'BUSINESS'"
        )
    else:
        op.execute(
            "UPDATE cashflow SET fund_nature = 'BUSINESS' WHERE fund_nature IS NULL"
        )
        op.execute("ALTER TABLE cashflow ALTER COLUMN fund_nature SET DEFAULT 'BUSINESS'")
    op.execute("ALTER TABLE cashflow ALTER COLUMN fund_nature SET NOT NULL")

    index_names = {item["name"] for item in inspector.get_indexes("cashflow")}
    if "ix_cashflow_nature" not in index_names:
        op.create_index("ix_cashflow_nature", "cashflow", ["nature"])
    if "ix_cashflow_fund_nature" not in index_names:
        op.create_index("ix_cashflow_fund_nature", "cashflow", ["fund_nature"])

    unique_constraints = {
        item["name"] for item in inspector.get_unique_constraints("order_type_pools")
    }
    if "uq_order_type_pools_route" not in unique_constraints:
        duplicate = bind.execute(
            sa.text(
                """
                SELECT order_type_id, portion, fund_nature
                FROM order_type_pools
                GROUP BY order_type_id, portion, fund_nature
                HAVING COUNT(*) > 1
                LIMIT 1
                """
            )
        ).first()
        if duplicate is not None:
            raise RuntimeError(
                "无法建立 uq_order_type_pools_route：order_type_pools 存在重复资金路由"
            )
        op.create_unique_constraint(
            "uq_order_type_pools_route",
            "order_type_pools",
            ["order_type_id", "portion", "fund_nature"],
        )

    _make_timestamp_required(bind, "cashflow")
    _make_timestamp_required(bind, "orders")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "uq_order_type_pools_route" in {
        item["name"] for item in inspector.get_unique_constraints("order_type_pools")
    }:
        op.drop_constraint("uq_order_type_pools_route", "order_type_pools", type_="unique")

    index_names = {item["name"] for item in inspector.get_indexes("cashflow")}
    if "ix_cashflow_fund_nature" in index_names:
        op.drop_index("ix_cashflow_fund_nature", table_name="cashflow")
    if "ix_cashflow_nature" in index_names:
        op.drop_index("ix_cashflow_nature", table_name="cashflow")

    for table_name in ("cashflow", "orders"):
        if not _column_is_nullable(bind, table_name, "created_at"):
            op.alter_column(
                table_name,
                "created_at",
                existing_type=sa.DateTime(),
                nullable=True,
            )

    # rebate_settlements 已确认是无数据的退役表，downgrade 不恢复死表。
