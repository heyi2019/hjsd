"""让四类建单表按板块顺序展示字段。"""
from alembic import op


revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET sort_order = "
        "CASE section "
        "WHEN 'ACCOUNT_PRODUCT' THEN 1000 "
        "WHEN 'BUSINESS' THEN 2000 "
        "WHEN 'FINANCE' THEN 3000 "
        "WHEN 'EXTRA' THEN 4000 "
        "WHEN 'PARTICIPANT' THEN 5000 "
        "ELSE 6000 END + sort_order "
        "WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ')"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET sort_order = sort_order - "
        "CASE section "
        "WHEN 'ACCOUNT_PRODUCT' THEN 1000 "
        "WHEN 'BUSINESS' THEN 2000 "
        "WHEN 'FINANCE' THEN 3000 "
        "WHEN 'EXTRA' THEN 4000 "
        "WHEN 'PARTICIPANT' THEN 5000 "
        "ELSE 6000 END "
        "WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ')"
    )

