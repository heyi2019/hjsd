"""初始化常用游戏类型的渠道／区服映射。"""
from alembic import op


revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    mappings = {
        "王者荣耀": '["安卓QQ","安卓微信","苹果微信","苹果QQ"]',
        "和平精英": '["安卓QQ","安卓微信","苹果微信","苹果QQ"]',
        "原神": '["官服","B服"]',
    }
    for name, regions in mappings.items():
        op.execute(
            "UPDATE game_type_options SET channel_regions = "
            f"'{regions}' WHERE name = '{name}'"
        )


def downgrade() -> None:
    op.execute(
        "UPDATE game_type_options SET channel_regions = NULL "
        "WHERE name IN ('王者荣耀', '和平精英', '原神')"
    )

