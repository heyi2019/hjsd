"""统一基础编号前缀。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0023_standardize_number_prefixes"
down_revision = "0022_rename_rebate_number"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    for key, prefix in (("ACCOUNT", "ACC"), ("INSTALLMENT", "INS"), ("EVENT", "EV"), ("CASHFLOW", "CF")):
        bind.execute(
            sa.text("UPDATE document_sequences SET prefix = :prefix WHERE sequence_key = :key"),
            {"key": key, "prefix": prefix},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for key, prefix in (("ACCOUNT", "HJACC"), ("INSTALLMENT", "HJINS"), ("EVENT", "HJE"), ("CASHFLOW", "HJF")):
        bind.execute(
            sa.text("UPDATE document_sequences SET prefix = :prefix WHERE sequence_key = :key"),
            {"key": key, "prefix": prefix},
        )
