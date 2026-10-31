"""Rename the order-form label for the shared transaction platform field."""

from alembic import op


revision = "0029_rename_intermediary_platform_to_trade_platform"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET label = '交易平台' "
        "WHERE field_key = 'intermediary_platform'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET label = '经手平台' "
        "WHERE field_key = 'intermediary_platform'"
    )

