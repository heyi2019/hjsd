"""封闭标准导入来源类型，清理 LEGACY_* 运行时取值。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0031_standardize_import_source_kinds"
down_revision = "0030_restrict_live_fields_to_customers"
branch_labels = None
depends_on = None

_STANDARD = (
    "STANDARD_ORDER",
    "STANDARD_ACCOUNT",
    "STANDARD_CASHFLOW",
    "STANDARD_INSTALLMENT",
    "STANDARD_LEAD",
)
_LEGACY_TO_STANDARD = {
    "LEGACY_ORDER": "STANDARD_ORDER",
    "LEGACY_ACCOUNT": "STANDARD_ACCOUNT",
    "LEGACY_CASHFLOW": "STANDARD_CASHFLOW",
    "LEGACY_INSTALLMENT": "STANDARD_INSTALLMENT",
    "LEGACY_LEAD": "STANDARD_LEAD",
}


def _check_sql() -> str:
    values = ", ".join(repr(value) for value in _STANDARD)
    return f"source_kind IN ({values})"


def upgrade() -> None:
    connection = op.get_bind()
    for legacy, standard in _LEGACY_TO_STANDARD.items():
        connection.execute(
            sa.text(
                "UPDATE import_batches SET source_kind = :standard "
                "WHERE source_kind = :legacy"
            ),
            {"standard": standard, "legacy": legacy},
        )
    with op.batch_alter_table("import_batches") as batch:
        batch.create_check_constraint("import_source_kind_valid", _check_sql())
    inspector = sa.inspect(connection)
    if not any(
        item.get("name") == "uq_accounts_inventory_no"
        for item in inspector.get_unique_constraints("accounts")
    ) and not any(
        item.get("name") == "uq_accounts_inventory_no"
        for item in inspector.get_indexes("accounts")
    ):
        op.create_index("uq_accounts_inventory_no", "accounts", ["inventory_no"], unique=True)


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if any(
        item.get("name") == "uq_accounts_inventory_no"
        for item in inspector.get_indexes("accounts")
    ):
        op.drop_index("uq_accounts_inventory_no", table_name="accounts")
    with op.batch_alter_table("import_batches") as batch:
        batch.drop_constraint("import_source_kind_valid", type_="check")
    for legacy, standard in _LEGACY_TO_STANDARD.items():
        connection.execute(
            sa.text(
                "UPDATE import_batches SET source_kind = :legacy "
                "WHERE source_kind = :standard"
            ),
            {"standard": standard, "legacy": legacy},
        )
