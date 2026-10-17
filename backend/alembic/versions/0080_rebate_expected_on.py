"""为返点记录增加预计到账日，支持逾期跟进（REB-01-08）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0080_rebate_expected_on"
down_revision = "0079_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("rebate_records")}
    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("rebate_records")}
    with op.batch_alter_table("rebate_records") as batch:
        if "expected_on" not in columns:
            batch.add_column(sa.Column("expected_on", sa.Date(), nullable=True))
        if "ix_rebate_records_expected_status" not in indexes:
            batch.create_index("ix_rebate_records_expected_status", ["expected_on", "status"])


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("rebate_records")}
    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("rebate_records")}
    with op.batch_alter_table("rebate_records") as batch:
        if "ix_rebate_records_expected_status" in indexes:
            batch.drop_index("ix_rebate_records_expected_status")
        if "expected_on" in columns:
            batch.drop_column("expected_on")
