"""add overdue installment disposition records"""

from alembic import op
import sqlalchemy as sa


revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "installment_dispositions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("installment_id", sa.Integer(), sa.ForeignKey("installments.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("related_order_id", sa.Integer(), sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.CheckConstraint("action IN ('RECOVER', 'RESELL')", name="installment_disposition_action_valid"),
        sa.UniqueConstraint("installment_id", "action", name="uq_installment_disposition_action"),
    )
    op.create_index(
        "ix_installment_dispositions_account",
        "installment_dispositions",
        ["account_id", "occurred_on"],
    )


def downgrade() -> None:
    op.drop_index("ix_installment_dispositions_account", table_name="installment_dispositions")
    op.drop_table("installment_dispositions")
