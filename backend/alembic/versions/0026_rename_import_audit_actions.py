"""标准化导入审计动作名称。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0026_rename_import_audit_actions"
down_revision = "0025_standard_import_contract"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for old, new in (
        ("HISTORY_LAND", "IMPORT_LAND"),
        ("HISTORY_COMMIT", "IMPORT_COMMIT"),
        ("HISTORY_MAP", "IMPORT_MAP"),
        ("HISTORY_MARK_UNLINKED", "IMPORT_MARK_UNLINKED"),
        ("HISTORY_ROLLBACK", "IMPORT_ROLLBACK"),
        ("HISTORY_CORRECTION", "IMPORT_CORRECTION"),
    ):
        op.get_bind().execute(
            sa.text("UPDATE audit_logs SET action = :new WHERE action = :old"),
            {"old": old, "new": new},
        )


def downgrade() -> None:
    for old, new in (
        ("IMPORT_LAND", "HISTORY_LAND"),
        ("IMPORT_COMMIT", "HISTORY_COMMIT"),
        ("IMPORT_MAP", "HISTORY_MAP"),
        ("IMPORT_MARK_UNLINKED", "HISTORY_MARK_UNLINKED"),
        ("IMPORT_ROLLBACK", "HISTORY_ROLLBACK"),
        ("IMPORT_CORRECTION", "HISTORY_CORRECTION"),
    ):
        op.get_bind().execute(
            sa.text("UPDATE audit_logs SET action = :new WHERE action = :old"),
            {"old": old, "new": new},
        )
