"""删除订单从属编号不再使用的独立序列。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0024_drop_unused_number_sequences"
down_revision = "0023_standardize_number_prefixes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "DELETE FROM document_sequences "
            "WHERE sequence_key IN ('INSTALLMENT', 'EVENT', 'REBATE')"
        )
    )


def downgrade() -> None:
    for key, prefix in (("INSTALLMENT", "INS"), ("EVENT", "EV"), ("REBATE", "RB")):
        op.get_bind().execute(
            sa.text(
                "INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) "
                "SELECT :key, :prefix, 4, 0 "
                "WHERE NOT EXISTS (SELECT 1 FROM document_sequences WHERE sequence_key = :key)"
            ),
            {"key": key, "prefix": prefix},
        )
