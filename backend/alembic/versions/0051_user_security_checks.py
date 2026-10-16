"""enforce valid user security scope and revoked token expiry"""
from __future__ import annotations

from alembic import op


revision = "0051_user_security_checks"
down_revision = "0050_sequence_value_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.create_check_constraint(
            "role_valid",
            "role IN ('ADMIN', 'OPERATOR', 'FINANCE', 'AUDITOR', 'VIEWER')",
        )
        batch.create_check_constraint(
            "owner_scope_valid",
            "owner_scope IN ('SELF', 'TEAM', 'ALL')",
        )

    with op.batch_alter_table("revoked_tokens") as batch:
        batch.create_check_constraint("expires_at_positive", "expires_at > 0")


def downgrade() -> None:
    with op.batch_alter_table("revoked_tokens") as batch:
        batch.drop_constraint("expires_at_positive", type_="check")

    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("owner_scope_valid", type_="check")
        batch.drop_constraint("role_valid", type_="check")
