"""新增经手平台基础数据词典。"""
from alembic import op


revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "INSERT INTO option_sets (code, label, \"group\", editable, options, description) "
        "SELECT 'INTERMEDIARY_PLATFORM', '经手平台', 'BUSINESS', 1, '[]', '回收、提号等业务的经手平台主数据' "
        "WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = 'INTERMEDIARY_PLATFORM')"
    )


def downgrade() -> None:
    op.execute("DELETE FROM option_sets WHERE code = 'INTERMEDIARY_PLATFORM'")
