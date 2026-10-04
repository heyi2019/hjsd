"""M0-客户与合作方 / M1 订单事件资金 / M2 账号分期押金返点

建表顺序严格按《ERP_数据库DDL与迁移方案_v1.0.md》§1：
policy_definitions → policy_versions → field_definitions → entity_extra_values →
customers / counterparties → accounts → orders → order_customer_roles /
order_counterparty_roles → order_profit_allocations → order_events → cashflow →
installments → installment_schedules → rebate_records → rebate_settlements → deposits。

- 所有金额列 `NUMERIC(18,2)`，不使用浮点（V15）；
- 编号唯一且不可复用（V19/V20）；
- 索引按 DDL §3 建立。

Revision ID: 0002_m1_business
Revises: 0001_m0_foundation
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_m1_business"
down_revision = "0001_m0_foundation"
branch_labels = None
depends_on = None

NOW = sa.text("CURRENT_TIMESTAMP")
MONEY = sa.Numeric(precision=18, scale=2)


def _audit_columns() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
    ]


def _stamp_columns() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=NOW, nullable=False),
    ]


def upgrade() -> None:
    # ---------------------------------------------------------- 经营规则 / 活字段
    op.create_table(
        "policy_definitions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("policy_code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("scope_id", sa.Integer(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.CheckConstraint(
            "status IN ('DRAFT','ACTIVE','EXPIRED')", name="policy_status_valid"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("policy_code", name="uq_policy_definitions_code"),
        *_audit_columns(),
    )
    op.create_table(
        "policy_versions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("policy_definition_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("approved_by", sa.String(length=64), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["policy_definition_id"], ["policy_definitions.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "policy_definition_id", "version", "effective_from",
            name="uq_policy_versions_scope",
        ),
        *_audit_columns(),
    )
    op.create_table(
        "field_definitions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("field_key", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("field_type", sa.String(length=16), nullable=False),
        sa.Column("options", sa.JSON(), nullable=True),
        sa.Column("required", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.CheckConstraint(
            "entity_type IN ('customer','account','order')", name="field_entity_valid"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entity_type", "field_key", name="uq_field_definitions_key"),
        *_audit_columns(),
    )
    op.create_table(
        "entity_extra_values",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("field_definition_id", sa.Integer(), nullable=False),
        sa.Column("value", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(
            ["field_definition_id"], ["field_definitions.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "entity_type", "entity_id", "field_definition_id",
            name="uq_entity_extra_values_unique",
        ),
        *_stamp_columns(),
    )

    # ---------------------------------------------------------- 客户 / 合作方
    op.create_table(
        "customers",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("customer_no", sa.String(length=32), nullable=False),
        sa.Column("display_name", sa.String(length=128), nullable=False),
        sa.Column("contact_name", sa.String(length=128), nullable=True),
        sa.Column("phone", sa.String(length=64), nullable=True),
        sa.Column("wechat", sa.String(length=128), nullable=True),
        sa.Column("qq", sa.String(length=64), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.Column("owner_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("merged_into_id", sa.Integer(), nullable=True),
        sa.Column("merged_reason", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('ACTIVE','DISABLED','MERGED')", name="customer_status_valid"
        ),
        sa.ForeignKeyConstraint(["merged_into_id"], ["customers.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("customer_no", name="uq_customers_no"),
        *_audit_columns(),
    )
    op.create_index("ix_customers_phone", "customers", ["phone"])
    op.create_index("ix_customers_wechat", "customers", ["wechat"])
    op.create_index("ix_customers_qq", "customers", ["qq"])
    op.create_table(
        "counterparties",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("counterparty_no", sa.String(length=32), nullable=False),
        sa.Column("display_name", sa.String(length=128), nullable=False),
        sa.Column("type", sa.String(length=16), nullable=False),
        sa.Column("contact_name", sa.String(length=128), nullable=True),
        sa.Column("phone", sa.String(length=64), nullable=True),
        sa.Column("wechat", sa.String(length=128), nullable=True),
        sa.Column("qq", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "type IN ('PEER','SUPPLIER','PLATFORM')", name="counterparty_type_valid"
        ),
        sa.CheckConstraint(
            "status IN ('ACTIVE','DISABLED')", name="counterparty_status_valid"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("counterparty_no", name="uq_counterparties_no"),
        *_audit_columns(),
    )
    op.create_index("ix_counterparties_type_status", "counterparties", ["type", "status"])

    # ---------------------------------------------------------- 账号
    op.create_table(
        "accounts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("account_no", sa.String(length=32), nullable=False),
        sa.Column("game_account", sa.String(length=128), nullable=True),
        sa.Column("platform", sa.String(length=64), nullable=True),
        sa.Column("region", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("buy_date", sa.Date(), nullable=True),
        sa.Column("cost_amount", MONEY, nullable=False),
        sa.Column("risk_level", sa.String(length=16), nullable=True),
        sa.Column("channels", sa.JSON(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('PENDING','IN_STOCK','INSTALLMENT','FOR_SALE','SOLD','VOID')",
            name="account_status_valid",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_no", name="uq_accounts_no"),
        sa.UniqueConstraint("game_account", name="uq_accounts_game_account"),
        *_audit_columns(),
    )
    op.create_index("ix_accounts_status", "accounts", ["status"])

    # ---------------------------------------------------------- 订单
    op.create_table(
        "orders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("order_no", sa.String(length=32), nullable=False),
        sa.Column("order_type", sa.String(length=16), nullable=False),
        sa.Column("capital_type", sa.String(length=16), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("link_status", sa.String(length=24), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('DRAFT','ACTIVE','COMPLETED','CANCELLED')",
            name="order_status_valid",
        ),
        sa.CheckConstraint(
            "capital_type IN ('STOCK','PASS_THRU','ZERO','CREDIT')",
            name="order_capital_type_valid",
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_no", name="uq_orders_no"),
        *_audit_columns(),
    )
    op.create_index("ix_orders_type_date", "orders", ["order_type", "trade_date"])
    op.create_index("ix_orders_link_status", "orders", ["link_status"])
    op.create_table(
        "order_customer_roles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.CheckConstraint(
            "role IN ('SELLER','BUYER','CONSIGNOR','INSTALLMENT_CUSTOMER')",
            name="customer_role_valid",
        ),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_id", "customer_id", "role", name="uq_order_customer_role"),
        *_stamp_columns(),
    )
    op.create_table(
        "order_counterparty_roles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("counterparty_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.ForeignKeyConstraint(
            ["counterparty_id"], ["counterparties.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "order_id", "counterparty_id", "role", name="uq_order_counterparty_role"
        ),
        *_stamp_columns(),
    )
    op.create_table(
        "order_profit_allocations",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("allocation_rate", MONEY, nullable=False),
        sa.Column("policy_version_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["policy_version_id"], ["policy_versions.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_id", "user_id", "role", name="uq_order_profit_alloc"),
        *_stamp_columns(),
    )

    # ---------------------------------------------------------- 事件与现金流
    op.create_table(
        "order_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("event_no", sa.String(length=32), nullable=False),
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=16), nullable=False),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("portion", sa.String(length=16), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("pool_id", sa.Integer(), nullable=True),
        sa.Column("offset_event_id", sa.Integer(), nullable=True),
        sa.Column("delivery_mode", sa.String(length=24), nullable=True),
        sa.Column("is_posted", sa.Boolean(), nullable=False),
        sa.Column("posted_at", sa.DateTime(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "event_type IN "
            "('BUY','COST','SELL','PAYMENT','DELIVER','TRANSFER','CANCEL')",
            name="event_type_valid",
        ),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["pool_id"], ["pools.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["offset_event_id"], ["order_events.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_no", name="uq_order_events_no"),
        *_audit_columns(),
    )
    op.create_index(
        "ix_order_events_order", "order_events", ["order_id", "event_type", "occurred_on"]
    )
    op.create_table(
        "cashflow",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("flow_no", sa.String(length=32), nullable=False),
        sa.Column("pool_id", sa.Integer(), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("nature", sa.String(length=16), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("direction", sa.String(length=8), nullable=False),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("order_event_id", sa.Integer(), nullable=True),
        sa.Column("transfer_id", sa.String(length=64), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "nature IN ('EXTERNAL_IN','BUSINESS_IN','BUSINESS_OUT','INTERNAL')",
            name="cashflow_nature_valid",
        ),
        sa.CheckConstraint(
            "direction IN ('IN','OUT')", name="cashflow_direction_valid"
        ),
        sa.ForeignKeyConstraint(["pool_id"], ["pools.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["order_event_id"], ["order_events.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("flow_no", name="uq_cashflow_no"),
        sa.UniqueConstraint("order_event_id", name="uq_cashflow_event"),
        *_audit_columns(),
    )
    op.create_index("ix_cashflow_pool_date", "cashflow", ["pool_id", "occurred_on"])
    op.create_index("ix_cashflow_nature", "cashflow", ["nature"])
    op.create_index("ix_cashflow_transfer", "cashflow", ["transfer_id"])

    # ---------------------------------------------------------- 分期
    op.create_table(
        "installments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("inst_no", sa.String(length=32), nullable=False),
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("contract_type", sa.String(length=24), nullable=False),
        sa.Column("principal", MONEY, nullable=False),
        sa.Column("down_payment", MONEY, nullable=False),
        sa.Column("periods", sa.Integer(), nullable=False),
        sa.Column("per_period", MONEY, nullable=False),
        sa.Column("paid_amount", MONEY, nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("delivery_mode", sa.String(length=24), nullable=True),
        sa.Column("delivered_on", sa.Date(), nullable=True),
        sa.Column("first_due_on", sa.Date(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "contract_type IN ('STOCK_SALE','ADVANCE_PURCHASE')",
            name="installment_contract_valid",
        ),
        sa.CheckConstraint(
            "status IN "
            "('PENDING','ACTIVE','OVERDUE','SETTLED','DELIVERED','DEFAULTED','CANCELLED')",
            name="installment_status_valid",
        ),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("inst_no", name="uq_installments_no"),
        sa.UniqueConstraint("order_id", name="uq_installments_order"),
        *_audit_columns(),
    )
    op.create_index("ix_installments_status", "installments", ["status", "first_due_on"])
    op.create_table(
        "installment_schedules",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("installment_id", sa.Integer(), nullable=False),
        sa.Column("period_no", sa.Integer(), nullable=False),
        sa.Column("due_on", sa.Date(), nullable=False),
        sa.Column("due_amount", MONEY, nullable=False),
        sa.Column("received_amount", MONEY, nullable=False),
        sa.Column("received_on", sa.Date(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.CheckConstraint(
            "status IN ('PENDING','PARTIAL','PAID','OVERDUE','WAIVED')",
            name="schedule_status_valid",
        ),
        sa.ForeignKeyConstraint(
            ["installment_id"], ["installments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("installment_id", "period_no", name="uq_installment_period"),
        *_stamp_columns(),
    )
    op.create_index(
        "ix_schedules_due",
        "installment_schedules",
        ["installment_id", "due_on", "status"],
    )

    # ---------------------------------------------------------- 返点
    op.create_table(
        "rebate_records",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("rebate_group_no", sa.String(length=32), nullable=False),
        sa.Column("source_order_id", sa.Integer(), nullable=True),
        sa.Column("channel", sa.String(length=64), nullable=True),
        sa.Column("rate", MONEY, nullable=False),
        sa.Column("base_amount", MONEY, nullable=False),
        sa.Column("link_status", sa.String(length=24), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("collected_on", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('OPEN','PARTIALLY_SETTLED','SETTLED','VOID')",
            name="rebate_status_valid",
        ),
        sa.ForeignKeyConstraint(["source_order_id"], ["orders.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("rebate_group_no", name="uq_rebate_records_no"),
        *_audit_columns(),
    )
    op.create_index("ix_rebate_source_order", "rebate_records", ["source_order_id"])

    # ---------------------------------------------------------- 押金
    op.create_table(
        "deposits",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("deposit_no", sa.String(length=32), nullable=False),
        sa.Column("pool_id", sa.Integer(), nullable=False),
        sa.Column("counterparty_id", sa.Integer(), nullable=True),
        sa.Column("source_order_id", sa.Integer(), nullable=True),
        sa.Column("paid_amount", MONEY, nullable=False),
        sa.Column("returned_amount", MONEY, nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("paid_on", sa.Date(), nullable=False),
        sa.Column("expected_release_on", sa.Date(), nullable=True),
        sa.Column("released_on", sa.Date(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('PAID','PARTIALLY_RETURNED','RETURNED','CANCELLED')",
            name="deposit_status_valid",
        ),
        sa.ForeignKeyConstraint(["pool_id"], ["pools.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["counterparty_id"], ["counterparties.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["source_order_id"], ["orders.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("deposit_no", name="uq_deposits_no"),
        *_audit_columns(),
    )
    op.create_table(
        "rebate_settlements",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("settlement_no", sa.String(length=48), nullable=False),
        sa.Column("rebate_record_id", sa.Integer(), nullable=False),
        sa.Column("settled_on", sa.Date(), nullable=False),
        sa.Column("gross_amount", MONEY, nullable=False),
        sa.Column("platform_fee", MONEY, nullable=False),
        sa.Column("net_amount", MONEY, nullable=False),
        sa.Column("cashflow_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["rebate_record_id"], ["rebate_records.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["cashflow_id"], ["cashflow.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("settlement_no", name="uq_rebate_settlements_no"),
        sa.UniqueConstraint("cashflow_id", name="uq_rebate_settlements_flow"),
        *_audit_columns(),
    )


def downgrade() -> None:
    for name in (
        "rebate_settlements",
        "deposits",
        "rebate_records",
        "installment_schedules",
        "installments",
        "cashflow",
        "order_events",
        "order_profit_allocations",
        "order_counterparty_roles",
        "order_customer_roles",
        "orders",
        "accounts",
        "counterparties",
        "customers",
        "entity_extra_values",
        "field_definitions",
        "policy_versions",
        "policy_definitions",
    ):
        op.drop_table(name)
