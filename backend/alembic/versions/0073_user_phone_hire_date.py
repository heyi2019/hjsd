"""为人员补齐手机号唯一性和入职日期。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0073_user_phone_hire_date"
down_revision = "0072_user_handover_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("hired_on", sa.Date(), nullable=True))
        batch.create_unique_constraint("uq_users_phone", ["phone"])


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("uq_users_phone", type_="unique")
        batch.drop_column("hired_on")
