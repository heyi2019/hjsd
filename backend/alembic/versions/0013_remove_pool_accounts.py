"""remove_pool_accounts：全量移除「资金池账户」板块（含 DB）。

用户裁决「全量移除(含DB)」——删除资金池账户模型、路由、服务、报表维度，
并清理相关选项词典。本迁移负责库结构回滚：

- cashflow：删除 pool_account_id 列（含索引 ix_cashflow_pool_account、外键
  fk_cashflow_pool_account_id）。
- reconciliations：删除 pool_account_id 列（含索引 ix_reconciliations_pool_account_id、
  外键 fk_reconciliations_pool_account_id），并将唯一约束 uq_reconciliations_scope
  由 (pool_id, pool_account_id, reconciled_on, account_label) 缩为
  (pool_id, reconciled_on, account_label)，与 ORM 对齐。
- 删除 pool_accounts 表。
- 删除 option_sets 词典 POOL_ACCOUNT_STATUS / POOL_ACCOUNT_TYPE，并从 ENTITY_TYPE
  的 options 中剔除 value='pool_account' 这一项（ENTITY_TYPE 行本身保留）。

downgrade 反向还原，使「upgrade head → downgrade base」仍可回到仅 alembic_version
表的状态，并保证可重复升级。

Revision ID: 13aab2c3d4e5
Revises: f2a3b4c5d6e7
Create Date: 2026-10-26 13:30:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet


revision: str = "13aab2c3d4e5"
down_revision: str | None = "f2a3b4c5d6e7"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 1. cashflow：去掉 pool_account_id 列/索引/外键
    #    注意：uq_reconciliations_scope 在 SQLite 中是「命名 UNIQUE 约束」（后端自动索引
    #    sqlite_autoindex_*），不是具名索引，必须用 drop_constraint(type_="unique") 而非
    #    drop_index。cashflow 的 ix_cashflow_pool_account 是真正的具名索引，可 drop_index。
    with op.batch_alter_table("cashflow") as batch_op:
        batch_op.drop_index("ix_cashflow_pool_account")
        batch_op.drop_constraint("fk_cashflow_pool_account_id", type_="foreignkey")
        batch_op.drop_column("pool_account_id")

    # 2. reconciliations：去掉 pool_account_id 列/索引/外键，唯一约束缩为 3 列
    #    uq_reconciliations_scope 在真实库中为 4 列 UNIQUE 约束
    #    (pool_id, pool_account_id, reconciled_on, account_label)，需先 drop 约束再删列，
    #    最后重建为与 ORM 对齐的 3 列约束 (pool_id, reconciled_on, account_label)。
    with op.batch_alter_table("reconciliations") as batch_op:
        batch_op.drop_index("ix_reconciliations_pool_account_id")
        batch_op.drop_constraint("fk_reconciliations_pool_account_id", type_="foreignkey")
        batch_op.drop_constraint("uq_reconciliations_scope", type_="unique")
        batch_op.drop_column("pool_account_id")
        batch_op.create_unique_constraint(
            "uq_reconciliations_scope",
            ["pool_id", "reconciled_on", "account_label"],
        )

    # 3. 删除 pool_accounts 表
    op.drop_table("pool_accounts")

    # 4. 清理 option_sets 中资金池账户相关词典
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        for code in ("POOL_ACCOUNT_STATUS", "POOL_ACCOUNT_TYPE"):
            row = session.scalars(
                select(OptionSet).where(OptionSet.code == code)
            ).first()
            if row is not None:
                session.delete(row)
        entity = session.scalars(
            select(OptionSet).where(OptionSet.code == "ENTITY_TYPE")
        ).first()
        if entity is not None and entity.options:
            entity.options = [
                o for o in entity.options if o.get("value") != "pool_account"
            ]
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    # 4. 还原 option_sets 数据（表由 0007 管理，此处仅恢复行）
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        entity = session.scalars(
            select(OptionSet).where(OptionSet.code == "ENTITY_TYPE")
        ).first()
        if entity is not None and not any(
            o.get("value") == "pool_account" for o in (entity.options or [])
        ):
            entity.options = (entity.options or []) + [
                {"value": "pool_account", "label": "资金池账户"}
            ]

        for code, label, options in (
            (
                "POOL_ACCOUNT_STATUS",
                "资金池账户状态",
                [
                    {"value": "ACTIVE", "label": "启用"},
                    {"value": "DISABLED", "label": "停用"},
                ],
            ),
            (
                "POOL_ACCOUNT_TYPE",
                "资金池账户类型",
                [
                    {"value": "BANK", "label": "银行账户"},
                    {"value": "CASH", "label": "现金"},
                    {"value": "THIRD_PARTY", "label": "第三方渠道"},
                ],
            ),
        ):
            exists = session.scalars(
                select(OptionSet).where(OptionSet.code == code)
            ).first()
            if exists is None:
                session.add(
                    OptionSet(
                        code=code,
                        label=label,
                        group="FUND",
                        editable=False,
                        options=options,
                        description=f"{code}（资金池账户，随 0013 回滚恢复）",
                    )
                )
        session.commit()
    finally:
        session.close()

    # 3. 重建 pool_accounts 表（与删除前的 ORM 定义保持一致）
    op.create_table(
        "pool_accounts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("pool_id", sa.Integer(), nullable=False),
        sa.Column("account_no", sa.String(length=64), nullable=False),
        sa.Column("account_name", sa.String(length=128), nullable=False),
        sa.Column("account_type", sa.String(length=16), nullable=False),
        sa.Column("ownership", sa.String(length=16), nullable=False),
        sa.Column(
            "opening_balance",
            sa.DECIMAL(precision=18, scale=2),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "current_balance",
            sa.DECIMAL(precision=18, scale=2),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="ACTIVE",
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "created_by",
            sa.String(length=64),
            nullable=False,
            server_default="system",
        ),
        sa.Column(
            "updated_by",
            sa.String(length=64),
            nullable=False,
            server_default="system",
        ),
        sa.CheckConstraint(
            "account_type IN ('BANK', 'CASH', 'THIRD_PARTY')",
            name=op.f("ck_pool_accounts_pool_account_type_valid"),
        ),
        sa.CheckConstraint(
            "ownership IN ('OWNED', 'CUSTODY', 'THIRD_PART')",
            name=op.f("ck_pool_accounts_pool_account_ownership_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('ACTIVE', 'DISABLED')",
            name=op.f("ck_pool_accounts_pool_account_status_valid"),
        ),
        sa.CheckConstraint(
            "opening_balance >= 0",
            name=op.f("ck_pool_accounts_pool_account_opening_balance_nonnegative"),
        ),
        sa.ForeignKeyConstraint(
            ["pool_id"],
            ["pools.id"],
            name=op.f("fk_pool_accounts_pool_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pool_accounts")),
        sa.UniqueConstraint("account_no", name="uq_pool_accounts_account_no"),
    )
    with op.batch_alter_table("pool_accounts") as batch_op:
        batch_op.create_index(
            batch_op.f("ix_pool_accounts_pool_id"), ["pool_id"], unique=False
        )

    # 2. 还原 reconciliations 的 pool_account_id 列/索引/外键/唯一约束
    with op.batch_alter_table("reconciliations") as batch_op:
        batch_op.drop_constraint("uq_reconciliations_scope", type_="unique")
        batch_op.add_column(sa.Column("pool_account_id", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_reconciliations_pool_account_id",
            "pool_accounts",
            ["pool_account_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(
            "ix_reconciliations_pool_account_id", ["pool_account_id"], unique=False
        )
        batch_op.create_unique_constraint(
            "uq_reconciliations_scope",
            ["pool_id", "pool_account_id", "reconciled_on", "account_label"],
        )

    # 1. 还原 cashflow 的 pool_account_id 列/索引/外键
    with op.batch_alter_table("cashflow") as batch_op:
        batch_op.add_column(sa.Column("pool_account_id", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_cashflow_pool_account_id",
            "pool_accounts",
            ["pool_account_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(
            "ix_cashflow_pool_account", ["pool_account_id", "occurred_on"], unique=False
        )
