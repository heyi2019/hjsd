"""补齐活字段适用业务、默认值和校验规则。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0084_field_definition_rules"
down_revision = "0083_generalize_live_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch:
        batch.add_column(sa.Column("default_value", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("applicable_order_types", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("validation_rule", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch:
        batch.drop_column("validation_rule")
        batch.drop_column("applicable_order_types")
        batch.drop_column("default_value")
