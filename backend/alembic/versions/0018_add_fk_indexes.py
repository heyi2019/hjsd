"""Add missing foreign-key indexes (FK leading-column coverage).

27 FK columns across 18 tables had no index whose leading column matched the
FK. They were added directly to the live database earlier; this migration makes
them official so `alembic check` stays clean and a future `autogenerate` will not
propose dropping them. Idempotent (IF NOT EXISTS) so it is safe to apply on a
database that already carries these indexes.
"""
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

# (index_name, table, column)
FK_INDEXES = [
    ("ix_customers_merged_into_id", "customers", "merged_into_id"),
    ("ix_customers_owner_id", "customers", "owner_id"),
    ("ix_order_customer_roles_customer_id", "order_customer_roles", "customer_id"),
    ("ix_deposits_counterparty_id", "deposits", "counterparty_id"),
    ("ix_deposits_source_order_id", "deposits", "source_order_id"),
    ("ix_deposits_pool_id", "deposits", "pool_id"),
    ("ix_import_batches_corrects_batch_id", "import_batches", "corrects_batch_id"),
    ("ix_import_rows_mapped_order_id", "import_rows", "mapped_order_id"),
    ("ix_import_rows_mapped_account_id", "import_rows", "mapped_account_id"),
    ("ix_order_counterparty_roles_counterparty_id", "order_counterparty_roles", "counterparty_id"),
    ("ix_order_type_pools_pool_id", "order_type_pools", "pool_id"),
    ("ix_installments_policy_version_id", "installments", "policy_version_id"),
    ("ix_users_handover_user_id", "users", "handover_user_id"),
    ("ix_customer_leads_converted_order_id", "customer_leads", "converted_order_id"),
    ("ix_rebate_records_policy_version_id", "rebate_records", "policy_version_id"),
    ("ix_entity_extra_values_field_definition_id", "entity_extra_values", "field_definition_id"),
    ("ix_orders_owner_id", "orders", "owner_id"),
    ("ix_orders_policy_version_id", "orders", "policy_version_id"),
    ("ix_orders_account_id", "orders", "account_id"),
    ("ix_reconciliations_pool_account_id", "reconciliations", "pool_account_id"),
    ("ix_installment_dispositions_related_order_id", "installment_dispositions", "related_order_id"),
    ("ix_rebate_settlements_rebate_record_id", "rebate_settlements", "rebate_record_id"),
    ("ix_rebate_settlements_fee_cashflow_id", "rebate_settlements", "fee_cashflow_id"),
    ("ix_order_events_pool_id", "order_events", "pool_id"),
    ("ix_order_events_offset_event_id", "order_events", "offset_event_id"),
    ("ix_order_profit_allocations_policy_version_id", "order_profit_allocations", "policy_version_id"),
    ("ix_order_profit_allocations_user_id", "order_profit_allocations", "user_id"),
]


def upgrade() -> None:
    for name, table, column in FK_INDEXES:
        op.execute(
            f'CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" ("{column}")'
        )


def downgrade() -> None:
    for name, table, column in FK_INDEXES:
        op.execute(f'DROP INDEX IF EXISTS "{name}"')
