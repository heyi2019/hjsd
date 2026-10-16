"""标准导入取代历史导入口径。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0025_standard_import_contract"
down_revision = "0024_drop_unused_number_sequences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE import_batches SET source_kind = 'STANDARD_ORDER' "
            "WHERE source_kind = 'LEGACY_ORDER'"
        )
    )
    with op.batch_alter_table("import_batches") as batch:
        batch.alter_column(
            "source_kind",
            existing_type=sa.String(length=32),
            existing_nullable=False,
            server_default="STANDARD_ORDER",
        )


def downgrade() -> None:
    with op.batch_alter_table("import_batches") as batch:
        batch.alter_column(
            "source_kind",
            existing_type=sa.String(length=32),
            existing_nullable=False,
            server_default="LEGACY_ORDER",
        )
