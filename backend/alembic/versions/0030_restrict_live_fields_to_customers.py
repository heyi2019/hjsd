"""restrict live fields to customer auxiliary data"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0030_restrict_live_fields_to_customers"
down_revision = "0029_rename_account_no_to_inventory_no"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch:
        batch.drop_constraint("field_entity_valid", type_="check")
        batch.create_check_constraint("field_entity_valid", "entity_type IN ('customer')")


def downgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch:
        batch.drop_constraint("field_entity_valid", type_="check")
        batch.create_check_constraint("field_entity_valid", "entity_type IN ('customer','account','order')")
