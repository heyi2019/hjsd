"""增加工作台业务提醒默认配置。"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "0074_seed_business_overview_reminders"
down_revision = "0073_remove_retired_product_checks"
branch_labels = None
depends_on = None

SET_CODE = "BUSINESS_OVERVIEW_REMINDERS"
DEFAULT_OPTIONS = [
    {"value": "inventory_aging_days", "label": "7"},
    {"value": "profit_notifications_enabled", "label": "1"},
    {"value": "overdue_installments_enabled", "label": "1"},
]


def upgrade() -> None:
    bind = op.get_bind()
    exists = bind.execute(
        sa.text("SELECT 1 FROM option_sets WHERE code = :code"),
        {"code": SET_CODE},
    ).scalar()
    if exists:
        return
    bind.execute(
        sa.text(
            "INSERT INTO option_sets "
            "(code, label, \"group\", editable, options, description, created_by, updated_by) "
            "VALUES (:code, :label, :group, :editable, :options, :description, :created_by, :updated_by)"
        ),
        {
            "code": SET_CODE,
            "label": "业务提醒",
            "group": "BUSINESS",
            "editable": True,
            "options": json.dumps(DEFAULT_OPTIONS),
            "description": "工作台库存、分润与逾期合约提醒规则",
            "created_by": "system",
            "updated_by": "system",
        },
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM option_sets WHERE code = :code").bindparams(code=SET_CODE))
