"""为全部表单作用域的业务实体补齐 JSON 扩展值列。"""
from alembic import op
import sqlalchemy as sa


revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


_TABLES = (
    "customer_leads",
    "counterparties",
    "deposits",
    "reconciliations",
    "rebate_records",
    "rebate_settlements",
    "period_locks",
)


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column("form_extra", sa.JSON(), nullable=True))


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_column(table, "form_extra")

