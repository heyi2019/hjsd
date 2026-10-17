"""Align database constraints with refund events and accounting."""
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("order_events") as batch:
        batch.drop_constraint(op.f("ck_order_events_event_type_valid"), type_="check")
        batch.create_check_constraint("event_type_valid", "event_type IN ('BUY', 'COST', 'SELL', 'PAYMENT', 'DELIVER', 'CANCEL', 'REFUND')")
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_constraint(op.f("ck_cashflow_cashflow_accounting_attribute_valid"), type_="check")
        batch.create_check_constraint("cashflow_accounting_attribute_valid", "accounting_attribute IN ('SELF_REVENUE', 'SELF_DIRECT_COST', 'TH_DIRECT_COST', 'TH_REVENUE', 'DFQ_PRINCIPAL', 'SERVICE_REVENUE', 'REBATE_INCOME', 'OPERATING_EXPENSE', 'DEPOSIT', 'EXTERNAL_FUNDING', 'INTERNAL_TRANSFER', 'REVERSAL', 'REFUND')")


def downgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_constraint(op.f("ck_cashflow_cashflow_accounting_attribute_valid"), type_="check")
        batch.create_check_constraint("cashflow_accounting_attribute_valid", "accounting_attribute IN ('SELF_REVENUE', 'SELF_DIRECT_COST', 'TH_DIRECT_COST', 'TH_REVENUE', 'DFQ_PRINCIPAL', 'SERVICE_REVENUE', 'REBATE_INCOME', 'OPERATING_EXPENSE', 'DEPOSIT', 'EXTERNAL_FUNDING', 'INTERNAL_TRANSFER', 'REVERSAL')")
    with op.batch_alter_table("order_events") as batch:
        batch.drop_constraint(op.f("ck_order_events_event_type_valid"), type_="check")
        batch.create_check_constraint("event_type_valid", "event_type IN ('BUY', 'COST', 'SELL', 'PAYMENT', 'DELIVER', 'TRANSFER', 'CANCEL')")
