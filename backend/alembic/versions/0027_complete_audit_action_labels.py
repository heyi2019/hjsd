"""补齐新增审计动作的中文名称。"""
from __future__ import annotations

import json

from alembic import op
from sqlalchemy import text


revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


LABELS = {
    "DEPOSIT_CANCEL": "取消押金",
    "REBATE_VOID": "作废返点",
    "IMPORT_REJECT": "驳回导入批次",
}


def upgrade() -> None:
    bind = op.get_bind()
    raw_options = bind.execute(
        text('SELECT options FROM option_sets WHERE code = \'AUDIT_ACTION\'')
    ).scalar_one_or_none()
    if raw_options is None:
        return

    options = raw_options if isinstance(raw_options, list) else json.loads(raw_options or "[]")
    existing = {item.get("value") for item in options if isinstance(item, dict)}
    for value, label in LABELS.items():
        if value in existing:
            for item in options:
                if isinstance(item, dict) and item.get("value") == value:
                    item["label"] = label
        else:
            options.append({"value": value, "label": label})

    bind.execute(
        text('UPDATE option_sets SET options = :options WHERE code = \'AUDIT_ACTION\''),
        {"options": json.dumps(options, ensure_ascii=False)},
    )


def downgrade() -> None:
    bind = op.get_bind()
    raw_options = bind.execute(
        text('SELECT options FROM option_sets WHERE code = \'AUDIT_ACTION\'')
    ).scalar_one_or_none()
    if raw_options is None:
        return

    options = raw_options if isinstance(raw_options, list) else json.loads(raw_options or "[]")
    options = [item for item in options if not isinstance(item, dict) or item.get("value") not in LABELS]
    bind.execute(
        text('UPDATE option_sets SET options = :options WHERE code = \'AUDIT_ACTION\''),
        {"options": json.dumps(options, ensure_ascii=False)},
    )
