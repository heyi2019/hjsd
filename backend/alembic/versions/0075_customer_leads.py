"""新增客户需求池（CUS-02）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0075_customer_leads"
down_revision = "0074_order_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "customer_leads",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("lead_no", sa.String(length=32), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("request_type", sa.String(length=32), nullable=False),
        sa.Column("budget", sa.Numeric(18, 2), nullable=True),
        sa.Column("target", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=True),
        sa.Column("converted_order_id", sa.Integer(), nullable=True),
        sa.Column("closed_reason", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "request_type IN ('FIND_ACCOUNT', 'SELL_ACCOUNT', 'SPECIFIC_SEARCH')",
            name="lead_type_valid",
        ),
        sa.CheckConstraint(
            "status IN ('OPEN', 'CONVERTED', 'CLOSED')",
            name="lead_status_valid",
        ),
        sa.CheckConstraint("budget IS NULL OR budget >= 0", name="lead_budget_nonneg"),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["converted_order_id"], ["orders.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("lead_no", name="uq_customer_leads_no"),
    )
    op.create_index(
        "ix_customer_leads_customer_status",
        "customer_leads",
        ["customer_id", "status"],
    )
    op.create_index(
        "ix_customer_leads_owner_status", "customer_leads", ["owner_id", "status"]
    )


def downgrade() -> None:
    op.drop_index("ix_customer_leads_owner_status", table_name="customer_leads")
    op.drop_index("ix_customer_leads_customer_status", table_name="customer_leads")
    op.drop_table("customer_leads")
