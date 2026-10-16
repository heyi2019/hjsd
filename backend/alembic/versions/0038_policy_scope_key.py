"""允许同一规则编码按不同作用域分别配置。

Revision ID: 0038_policy_scope_key
Revises: 0037_add_order_account_snapshot
"""
from __future__ import annotations

from alembic import op


revision = "0038_policy_scope_key"
down_revision = "0037_add_order_account_snapshot"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("policy_definitions", recreate="always") as batch:
        batch.drop_constraint("uq_policy_definitions_code", type_="unique")
        batch.create_unique_constraint(
            "uq_policy_definitions_scope_code",
            ["policy_code", "scope_type", "scope_id"],
        )


def downgrade() -> None:
    with op.batch_alter_table("policy_definitions", recreate="always") as batch:
        batch.drop_constraint("uq_policy_definitions_scope_code", type_="unique")
        batch.create_unique_constraint(
            "uq_policy_definitions_code", ["policy_code"]
        )
