"""同步审计动作词典与当前运行时动作清单。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.domain.enums import AuditAction


revision = "0007_sync_audit_action_option_set"
down_revision = "0006_remove_retired_cost_option"
branch_labels = None
depends_on = None


_ADDITIONAL_LABELS = {
    "ACCOUNT_DELETE": "删除账号",
    "LIST_COLUMNS_UPDATE": "列表列显示配置变更",
    "LIST_COLUMNS_RESET": "列表列配置恢复默认",
    "LIST_COLUMN_ADD": "列表新增自定义列",
    "LIST_COLUMN_REMOVE": "列表删除自定义列",
    "LIST_EXPORT": "导出列表",
    "REBATE_UPDATE": "编辑返点",
    "REBATE_DELETE": "删除返点",
    "WECHAT_BIND": "绑定微信",
    "WECHAT_UNBIND": "解绑微信",
}


def upgrade() -> None:
    bind = op.get_bind()
    table = sa.table(
        "option_sets",
        sa.column("code", sa.String),
        sa.column("options", sa.JSON),
    )
    row = bind.execute(
        sa.select(table.c.options).where(table.c.code == "AUDIT_ACTION")
    ).first()
    if row is None:
        return
    existing = {item.get("value"): item for item in (row.options or [])}
    options = [
        existing.get(
            action.value,
            {"value": action.value, "label": _ADDITIONAL_LABELS.get(action.value, action.value)},
        )
        for action in AuditAction
    ]
    bind.execute(
        sa.update(table)
        .where(table.c.code == "AUDIT_ACTION")
        .values(options=options)
    )


def downgrade() -> None:
    # 该词典的旧版本包含历史动作，无法可靠地恢复管理员改过的展示文案；
    # 保留当前值集合，避免回滚操作覆盖运行期文案配置。
    return
