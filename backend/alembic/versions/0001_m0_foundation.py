"""M0 工程与数据库底座

建立：pools / order_type_defs / order_type_pools / document_sequences / audit_logs，
并写入四类主业务（HS/TH/DG/DFQ）、两个种子资金池（HJ_INVEST/HJ_PROFIT）与默认资金路由。

- 迁移可重复执行：种子按 code 幂等，已存在则跳过且不改写；
- 绝不触碰旧 `heijin.db` / `heijin_v2.db`：目标库由 `core.settings` 单一决定（V15/V17）。

Revision ID: 0001_m0_foundation
Revises: None
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.orm import Session

revision = "0001_m0_foundation"
down_revision = None
branch_labels = None
depends_on = None

NOW = sa.text("CURRENT_TIMESTAMP")


def upgrade() -> None:
    op.create_table(
        "pools",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("pool_type", sa.String(length=32), nullable=False),
        sa.Column("ownership", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "ownership IN ('OWNED', 'CUSTODY', 'THIRD_PART')", name="ownership_valid"
        ),
        sa.CheckConstraint("status IN ('ACTIVE', 'DISABLED')", name="status_valid"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code", name="uq_pools_code"),
    )

    op.create_table(
        "order_type_defs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("capital_type", sa.String(length=16), nullable=False),
        sa.Column("sequence_prefix", sa.String(length=16), nullable=False),
        sa.Column("sequence_key", sa.String(length=64), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "capital_type IN ('STOCK', 'PASS_THRU', 'ZERO', 'CREDIT')", name="capital_type_valid"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code", name="uq_order_type_defs_code"),
    )

    op.create_table(
        "order_type_pools",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("order_type_id", sa.Integer(), nullable=False),
        sa.Column("pool_id", sa.Integer(), nullable=False),
        sa.Column("portion", sa.String(length=16), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.CheckConstraint(
            "portion IN ('PRINCIPAL', 'PROFIT', 'GROSS')", name="portion_valid"
        ),
        sa.ForeignKeyConstraint(["order_type_id"], ["order_type_defs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["pool_id"], ["pools.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_type_id", "portion", name="uq_order_type_pools_route"),
    )

    op.create_table(
        "document_sequences",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("sequence_key", sa.String(length=64), nullable=False),
        sa.Column("prefix", sa.String(length=16), nullable=False),
        sa.Column("padding", sa.Integer(), nullable=False),
        sa.Column("current_value", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sequence_key", name="uq_document_sequences_key"),
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("occurred_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("actor", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("before_json", sa.JSON(), nullable=True),
        sa.Column("after_json", sa.JSON(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    _seed_foundation()


def downgrade() -> None:
    op.drop_table("audit_logs")
    op.drop_table("document_sequences")
    op.drop_table("order_type_pools")
    op.drop_table("order_type_defs")
    op.drop_table("pools")


def _seed_foundation() -> None:
    """写入基础种子（幂等）。"""
    from app.foundation.seeds import seed_foundation

    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        stats = seed_foundation(session, actor="system")
        session.commit()
        print(f"[0001_m0_foundation] seed stats: {stats}")  # noqa: T201
    finally:
        session.close()
