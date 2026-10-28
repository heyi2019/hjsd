"""为表单字段增加归属板块。"""
from alembic import op
import sqlalchemy as sa

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "order_form_fields",
        sa.Column("section", sa.String(length=16), nullable=False, server_default="ORDER"),
    )


def downgrade() -> None:
    op.drop_column("order_form_fields", "section")
