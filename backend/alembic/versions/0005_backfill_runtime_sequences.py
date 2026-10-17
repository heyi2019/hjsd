"""backfill sequence domains introduced after the baseline seed.

Older v1 databases can already have the foundation tables and therefore skip
the baseline seed, while newer endpoints still need the lead, quality and
notification number domains.  Insert only missing rows so existing counters
remain unchanged.
"""
from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SEQUENCES = (
    ("LEAD", "REQ"),
    ("QUALITY_ISSUE", "QI"),
    ("NOTIFICATION", "NTF"),
)


def upgrade() -> None:
    bind = op.get_bind()
    for key, prefix in SEQUENCES:
        exists = bind.execute(
            sa.text("SELECT 1 FROM document_sequences WHERE sequence_key = :key"),
            {"key": key},
        ).scalar()
        if exists is None:
            bind.execute(
                sa.text(
                    "INSERT INTO document_sequences "
                    "(sequence_key, prefix, padding, current_value) "
                    "VALUES (:key, :prefix, 4, 0)"
                ),
                {"key": key, "prefix": prefix},
            )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "DELETE FROM document_sequences "
            "WHERE sequence_key IN ('LEAD', 'QUALITY_ISSUE', 'NOTIFICATION')"
        )
    )
