"""活字段扩展到订单、账号等业务实体。"""
from __future__ import annotations

from alembic import op


revision = "0083_generalize_live_fields"
down_revision = "0082_require_rebate_order"
branch_labels = None
depends_on = None

_ENTITY_TYPES = (
    "'order'",
    "'account'",
    "'customer'",
    "'installment'",
    "'pool'",
    "'cashflow'",
    "'lead'",
    "'counterparty'",
)
_ENTITY_CHECK = f"entity_type IN ({', '.join(_ENTITY_TYPES)})"


def upgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch:
        batch.drop_constraint("field_entity_valid", type_="check")
        batch.create_check_constraint("field_entity_valid", _ENTITY_CHECK)
    with op.batch_alter_table("entity_extra_values") as batch:
        batch.drop_constraint("extra_value_entity_valid", type_="check")
        batch.create_check_constraint("extra_value_entity_valid", _ENTITY_CHECK)


def downgrade() -> None:
    with op.batch_alter_table("entity_extra_values") as batch:
        batch.drop_constraint("extra_value_entity_valid", type_="check")
        batch.create_check_constraint("extra_value_entity_valid", "entity_type = 'customer'")
    with op.batch_alter_table("field_definitions") as batch:
        batch.drop_constraint("field_entity_valid", type_="check")
        batch.create_check_constraint("field_entity_valid", "entity_type = 'customer'")
