"""integrity hardening：补齐缺失外键 + 金额非负 CHECK + 纯日期索引（审计 2026-10-13，P1/P2）。

背景（先核验后执行）：
- 生产库 users=0、其余引用表=0、金额无负值、owner_id 全 NULL → 加约束零存量冲突。
- `users` 表空：利润/负责人 user_id 与 owner_id 一律 `SET NULL`，仅阻止“指向不存在用户”，
  不强制必须有主（避免空用户表阻断合法写入的鸡生蛋问题）。
- 订单角色 order_id 用 `CASCADE`（删订单级联清角色，角色是订单的子实体）。
- SQLite 不支持 ADD CONSTRAINT，FK/CHECK 一律走 batch 重建；索引用 create_index（无需重建）。

幂等性：本迁移在 SQLite 上曾因 `database.py` 全局 FK 监听 + 事务内 `PRAGMA` 失效而静默回滚，
可能在不同环境（本地/生产/ECS）留下部分产物。故每个 create 都先查存在性，已存在则跳过，
保证在“干净 0007”或“部分 0008 残留”两种状态下都能安全重跑。

命名：CHECK 约束名只用后缀（如 `cost_nonneg`），由 database.py 的 NAMING_CONVENTION
（`ck: ck_%(table_name)s_%(constraint_name)s`）补出 `ck_<表>_<后缀>`，避免重复前缀；
FK 名已为 `fk_<表>_<列>`，与约定输出一致，无需改动。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import inspect, text, Integer as SAInteger


revision = "0008_integrity_constraints"
down_revision = "0007_teams"
branch_labels = None
depends_on = None


def _index_exists(insp, table: str, name: str) -> bool:
    return any(i["name"] == name for i in insp.get_indexes(table))


def _fk_exists(insp, table: str, name: str) -> bool:
    return any(fk.get("name") == name for fk in insp.get_foreign_keys(table))


def _check_exists(bind, table: str, name: str) -> bool:
    # SQLite 的 CHECK 名在 pragma 里不一定可靠，直接扫 sqlite_master 的建表 SQL 最稳。
    rows = bind.execute(
        text(
            "SELECT sql FROM sqlite_master "
            "WHERE type IN ('table','trigger') AND tbl_name = :t"
        ),
        {"t": table},
    ).fetchall()
    return any(name in (r[0] or "") for r in rows)


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)

    # ---- 缺失外键（SET NULL，仅阻止孤儿引用）----
    with op.batch_alter_table("orders") as b:
        if not _fk_exists(insp, "orders", "fk_orders_owner_id"):
            b.create_foreign_key("fk_orders_owner_id", "users", ["owner_id"], ["id"], ondelete="SET NULL")
        if not _index_exists(insp, "orders", "ix_orders_trade_date"):
            b.create_index("ix_orders_trade_date", ["trade_date"])

    with op.batch_alter_table("customers") as b:
        if not _fk_exists(insp, "customers", "fk_customers_owner_id"):
            b.create_foreign_key("fk_customers_owner_id", "users", ["owner_id"], ["id"], ondelete="SET NULL")

    with op.batch_alter_table("order_profit_allocations") as b:
        if not _fk_exists(insp, "order_profit_allocations", "fk_order_profit_allocations_user_id"):
            b.create_foreign_key("fk_order_profit_allocations_user_id", "users", ["user_id"], ["id"], ondelete="SET NULL")
        # user_id 在 ORM 已改为可空（配合 ondelete=SET NULL）；DB 旧结构为 NOT NULL，
        # batch 重建会保留旧可空性，故显式改回可空以对齐 ORM、消除 alembic check 漂移。
        b.alter_column("user_id", existing_type=SAInteger(), nullable=True)
        if not _check_exists(bind, "order_profit_allocations", "ck_order_profit_allocations_rate_nonneg"):
            b.create_check_constraint("rate_nonneg", "allocation_rate >= 0")

    # ---- 订单角色 order_id 外键（CASCADE）----
    with op.batch_alter_table("order_customer_roles") as b:
        if not _fk_exists(insp, "order_customer_roles", "fk_order_customer_roles_order_id"):
            b.create_foreign_key("fk_order_customer_roles_order_id", "orders", ["order_id"], ["id"], ondelete="CASCADE")
    with op.batch_alter_table("order_counterparty_roles") as b:
        if not _fk_exists(insp, "order_counterparty_roles", "fk_order_counterparty_roles_order_id"):
            b.create_foreign_key("fk_order_counterparty_roles_order_id", "orders", ["order_id"], ["id"], ondelete="CASCADE")

    # ---- 金额非负 CHECK + 纯日期索引 ----
    with op.batch_alter_table("order_events") as b:
        if not _check_exists(bind, "order_events", "ck_order_events_amount_nonneg"):
            b.create_check_constraint("amount_nonneg", "amount >= 0")
        if not _index_exists(insp, "order_events", "ix_order_events_occurred_on"):
            b.create_index("ix_order_events_occurred_on", ["occurred_on"])

    with op.batch_alter_table("cashflow") as b:
        if not _check_exists(bind, "cashflow", "ck_cashflow_amount_nonneg"):
            b.create_check_constraint("amount_nonneg", "amount >= 0")
        if not _index_exists(insp, "cashflow", "ix_cashflow_occurred_on"):
            b.create_index("ix_cashflow_occurred_on", ["occurred_on"])

    with op.batch_alter_table("accounts") as b:
        if not _check_exists(bind, "accounts", "ck_accounts_cost_nonneg"):
            b.create_check_constraint("cost_nonneg", "cost_amount >= 0")

    with op.batch_alter_table("installments") as b:
        if not _check_exists(bind, "installments", "ck_installments_amount_nonneg"):
            b.create_check_constraint(
                "amount_nonneg",
                "principal >= 0 AND down_payment >= 0 AND per_period >= 0 AND paid_amount >= 0",
            )

    with op.batch_alter_table("installment_schedules") as b:
        if not _check_exists(bind, "installment_schedules", "ck_installment_schedules_amount_nonneg"):
            b.create_check_constraint(
                "amount_nonneg",
                "due_amount >= 0 AND received_amount >= 0",
            )

    with op.batch_alter_table("deposits") as b:
        if not _check_exists(bind, "deposits", "ck_deposits_amount_nonneg"):
            b.create_check_constraint(
                "amount_nonneg",
                "paid_amount >= 0 AND returned_amount >= 0",
            )

    with op.batch_alter_table("rebate_records") as b:
        if not _check_exists(bind, "rebate_records", "ck_rebate_records_amount_nonneg"):
            b.create_check_constraint(
                "amount_nonneg",
                "rate >= 0 AND base_amount >= 0",
            )

    with op.batch_alter_table("rebate_settlements") as b:
        if not _check_exists(bind, "rebate_settlements", "ck_rebate_settlements_amount_nonneg"):
            b.create_check_constraint(
                "amount_nonneg",
                "gross_amount >= 0 AND platform_fee >= 0 AND net_amount >= 0",
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)

    with op.batch_alter_table("rebate_settlements") as b:
        if _check_exists(bind, "rebate_settlements", "ck_rebate_settlements_amount_nonneg"):
            b.drop_constraint("amount_nonneg", type_="check")
    with op.batch_alter_table("rebate_records") as b:
        if _check_exists(bind, "rebate_records", "ck_rebate_records_amount_nonneg"):
            b.drop_constraint("amount_nonneg", type_="check")
    with op.batch_alter_table("deposits") as b:
        if _check_exists(bind, "deposits", "ck_deposits_amount_nonneg"):
            b.drop_constraint("amount_nonneg", type_="check")
    with op.batch_alter_table("installment_schedules") as b:
        if _check_exists(bind, "installment_schedules", "ck_installment_schedules_amount_nonneg"):
            b.drop_constraint("amount_nonneg", type_="check")
    with op.batch_alter_table("installments") as b:
        if _check_exists(bind, "installments", "ck_installments_amount_nonneg"):
            b.drop_constraint("amount_nonneg", type_="check")
    with op.batch_alter_table("accounts") as b:
        if _check_exists(bind, "accounts", "ck_accounts_cost_nonneg"):
            b.drop_constraint("cost_nonneg", type_="check")
    with op.batch_alter_table("cashflow") as b:
        if _check_exists(bind, "cashflow", "ck_cashflow_amount_nonneg"):
            b.drop_constraint("amount_nonneg", type_="check")
        if _index_exists(insp, "cashflow", "ix_cashflow_occurred_on"):
            b.drop_index("ix_cashflow_occurred_on")
    with op.batch_alter_table("order_events") as b:
        if _check_exists(bind, "order_events", "ck_order_events_amount_nonneg"):
            b.drop_constraint("amount_nonneg", type_="check")
        if _index_exists(insp, "order_events", "ix_order_events_occurred_on"):
            b.drop_index("ix_order_events_occurred_on")
    with op.batch_alter_table("order_counterparty_roles") as b:
        if _fk_exists(insp, "order_counterparty_roles", "fk_order_counterparty_roles_order_id"):
            b.drop_constraint("fk_order_counterparty_roles_order_id", type_="foreignkey")
    with op.batch_alter_table("order_customer_roles") as b:
        if _fk_exists(insp, "order_customer_roles", "fk_order_customer_roles_order_id"):
            b.drop_constraint("fk_order_customer_roles_order_id", type_="foreignkey")
    with op.batch_alter_table("order_profit_allocations") as b:
        if _check_exists(bind, "order_profit_allocations", "ck_order_profit_allocations_rate_nonneg"):
            b.drop_constraint("rate_nonneg", type_="check")
        if _fk_exists(insp, "order_profit_allocations", "fk_order_profit_allocations_user_id"):
            b.drop_constraint("fk_order_profit_allocations_user_id", type_="foreignkey")
    with op.batch_alter_table("customers") as b:
        if _fk_exists(insp, "customers", "fk_customers_owner_id"):
            b.drop_constraint("fk_customers_owner_id", type_="foreignkey")
    with op.batch_alter_table("orders") as b:
        if _index_exists(insp, "orders", "ix_orders_trade_date"):
            b.drop_index("ix_orders_trade_date")
        if _fk_exists(insp, "orders", "fk_orders_owner_id"):
            b.drop_constraint("fk_orders_owner_id", type_="foreignkey")
