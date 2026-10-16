"""restrict extra values to the active customer field domain"""
from __future__ import annotations

from alembic import op


revision = "0063_extra_value_entity_check"
down_revision = "0062_installment_period_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("entity_extra_values") as batch:
        batch.create_check_constraint(
            "extra_value_entity_valid",
            "entity_type = 'customer'",
        )


def downgrade() -> None:
    with op.batch_alter_table("entity_extra_values") as batch:
        batch.drop_constraint("extra_value_entity_valid", type_="check")
