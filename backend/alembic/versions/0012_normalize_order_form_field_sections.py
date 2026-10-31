"""统一表单字段归属板块命名。"""
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'EXTRA' WHERE section = 'ORDER'")
    op.execute("UPDATE order_form_fields SET section = 'ACCOUNT_PRODUCT' WHERE section = 'ACCOUNT'")
    op.execute("UPDATE order_form_fields SET section = 'PARTICIPANT' WHERE section = 'CUSTOMER'")


def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'ORDER' WHERE section = 'EXTRA'")
    op.execute("UPDATE order_form_fields SET section = 'ACCOUNT' WHERE section = 'ACCOUNT_PRODUCT'")
    op.execute("UPDATE order_form_fields SET section = 'CUSTOMER' WHERE section = 'PARTICIPANT'")

