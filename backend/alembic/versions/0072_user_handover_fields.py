"""为人员停用与业务交接补齐状态字段。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0072_user_handover_fields"
down_revision = "0071_installment_amount_invariants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("deactivated_on", sa.Date(), nullable=True))
        batch.add_column(sa.Column("handover_user_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("handover_note", sa.Text(), nullable=True))
        batch.create_foreign_key(
            "fk_users_handover_user_id", "users", ["handover_user_id"], ["id"], ondelete="SET NULL"
        )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("fk_users_handover_user_id", type_="foreignkey")
        batch.drop_column("handover_note")
        batch.drop_column("handover_user_id")
        batch.drop_column("deactivated_on")
