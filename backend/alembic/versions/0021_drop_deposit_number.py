"""移除无业务意义的押金单号，押金通过资金流水和内部主键追溯。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text


revision = "0021_drop_deposit_number"
down_revision = "0020_account_description_images"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("deposits") as batch:
        batch.drop_column("deposit_no")
    op.get_bind().execute(
        text("DELETE FROM document_sequences WHERE sequence_key = 'DEPOSIT'")
    )


def downgrade() -> None:
    import sqlalchemy as sa

    with op.batch_alter_table("deposits") as batch:
        batch.add_column(sa.Column("deposit_no", sa.String(length=32), nullable=True))

    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE deposits SET deposit_no = 'LEGACY-DEP-' || id "
            "WHERE deposit_no IS NULL"
        )
    )
    with op.batch_alter_table("deposits") as batch:
        batch.alter_column("deposit_no", nullable=False)
        batch.create_unique_constraint("uq_deposits_no", ["deposit_no"])
