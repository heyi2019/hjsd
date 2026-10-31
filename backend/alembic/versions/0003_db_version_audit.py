"""数据库版本审计表：记录每次发版对库结构的戳记。

决策（2026-10-31）：数据库版本「随推送版本来」——即等于发布/推送的 app 版本号
（如 1.0.1 / 1.0.2），由发版动作戳记，**不**再使用独立的迁移风格单调计数器（0072…）。

本迁移仅建表（审计历史），不写死任何版本值；具体版本在部署时由
`scripts/stamp_db_version.py` 读取当前 APP_VERSION 与 alembic head 后插入。
down_revision = 0002_squash（压平终态）；本文件为新的唯一 head。
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_db_version_audit"
down_revision = "0002_squash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "db_version",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("app_version", sa.String(length=32), nullable=False),
        sa.Column("alembic_revision", sa.String(length=64), nullable=False),
        sa.Column(
            "applied_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    # 审计表按时间倒序查询高频，建索引便于「当前 DB 版本」快速定位。
    op.create_index("ix_db_version_applied_at", "db_version", ["applied_at"])


def downgrade() -> None:
    op.drop_index("ix_db_version_applied_at", table_name="db_version")
    op.drop_table("db_version")
