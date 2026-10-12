"""Add first-class users for login and administration."""
from alembic import op
import sqlalchemy as sa

revision = "0006_users_auth"
down_revision = "0005_m5_policy_snapshot"


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(128), nullable=False),
        sa.Column("password_hash", sa.String(256), nullable=False),
        sa.Column("role", sa.String(32), nullable=False, server_default="VIEWER"),
        sa.Column("owner_scope", sa.String(16), nullable=False, server_default="SELF"),
        sa.Column("pool_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("team_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("phone", sa.String(32)),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("note", sa.Text()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )
    op.create_table(
        "revoked_tokens",
        sa.Column("jti", sa.String(64), primary_key=True),
        sa.Column("expires_at", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("revoked_tokens")
    op.drop_table("users")
