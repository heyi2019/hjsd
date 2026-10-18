"""Store explicitly selected execution operators separately from the creator."""
from alembic import op
import sqlalchemy as sa

revision = "0002_event_operators"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("order_events", sa.Column("operator_user_ids", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("order_events", "operator_user_ids")
