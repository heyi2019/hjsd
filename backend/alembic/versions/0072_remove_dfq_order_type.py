"""下线代分期（DFQ）：移除业务类型定义、资金路由、编号域、表单字段与选项词典条目。

背景：代分期功能整体下线，后端枚举已移除 DFQ / ADVANCE_PURCHASE / DFQ_PRINCIPAL。
本迁移只处理**配置与元数据**，不删业务流水——存量 DFQ 订单与代分期合约由运维在
备份后单独清理（见部署说明），避免迁移在生产库上静默销毁业务数据。

不改动 0001_baseline：它是历史快照，重写已应用迁移会让线上库与迁移链不一致。
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "0072_remove_dfq_order_type"
down_revision = "0071_rename_account_waiting_status"
branch_labels = None
depends_on = None


# 需要从 options JSON 里剔除的取值（含各选项集里的中英显示名，供 downgrade 复原）
_REMOVED_OPTIONS: dict[str, str] = {
    "DFQ": "代分期",
    "ORDER_DFQ": "代分期订单",
    "ADVANCE_PURCHASE": "代分期",
    "DFQ_PRINCIPAL": "代分期借款本金",
}


def _strip_options(raw: str | None) -> str | None:
    """剔除已下线取值；非目标结构原样返回。"""
    if not raw:
        return raw
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        return raw
    if not isinstance(items, list) or not any(
        isinstance(item, dict) and item.get("value") in _REMOVED_OPTIONS for item in items
    ):
        return raw
    kept = [
        item
        for item in items
        if not (isinstance(item, dict) and item.get("value") in _REMOVED_OPTIONS)
    ]
    return json.dumps(kept, ensure_ascii=False)


def _restore_options(raw: str | None) -> str | None:
    """downgrade：把被剔除的取值补回列表尾部（已存在则跳过）。"""
    if not raw:
        return raw
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        return raw
    if not isinstance(items, list):
        return raw
    present = {item.get("value") for item in items if isinstance(item, dict)}
    for value, label in _REMOVED_OPTIONS.items():
        if value not in present:
            items.append({"value": value, "label": label})
    return json.dumps(items, ensure_ascii=False)


def _rewrite_option_json(mode: str) -> None:
    transform = _strip_options if mode == "upgrade" else _restore_options
    bind = op.get_bind()
    for table in ("option_sets", "order_form_fields"):
        rows = bind.execute(
            sa.text(f'SELECT id, options FROM "{table}" WHERE options IS NOT NULL')
        ).fetchall()
        for row_id, raw in rows:
            updated = transform(raw)
            if updated != raw:
                bind.execute(
                    sa.text(f'UPDATE "{table}" SET options = :options WHERE id = :id'),
                    {"options": updated, "id": row_id},
                )


def upgrade() -> None:
    op.execute(sa.text("DELETE FROM order_form_fields WHERE order_type_code = 'DFQ'"))
    op.execute(
        sa.text(
            "DELETE FROM order_type_pools WHERE order_type_id IN "
            "(SELECT id FROM order_type_defs WHERE code = 'DFQ')"
        )
    )
    op.execute(sa.text("DELETE FROM order_type_defs WHERE code = 'DFQ'"))
    op.execute(sa.text("DELETE FROM document_sequences WHERE sequence_key = 'ORDER_DFQ'"))
    _rewrite_option_json("upgrade")


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "INSERT INTO order_type_defs (code, name, capital_type, sequence_prefix, "
            "sequence_key, is_active, sort_order, description, created_by, updated_by) "
            "VALUES ('DFQ', '代分期', 'CREDIT', 'DFQ', 'ORDER_DFQ', 1, 40, '代分期服务', "
            "'system', 'system')"
        )
    )
    bind.execute(
        sa.text(
            "INSERT INTO document_sequences (sequence_key, prefix, padding, current_value) "
            "VALUES ('ORDER_DFQ', 'DFQ', 4, 0)"
        )
    )
    bind.execute(
        sa.text(
            "INSERT INTO order_type_pools (order_type_id, pool_id, portion, priority, is_active) "
            "SELECT t.id, p.id, :portion, 0, 1 "
            "FROM order_type_defs t, pools p "
            "WHERE t.code = 'DFQ' AND p.code = :pool"
        ),
        {"portion": "PRINCIPAL", "pool": "HJ_INVEST"},
    )
    bind.execute(
        sa.text(
            "INSERT INTO order_type_pools (order_type_id, pool_id, portion, priority, is_active) "
            "SELECT t.id, p.id, :portion, 0, 1 "
            "FROM order_type_defs t, pools p "
            "WHERE t.code = 'DFQ' AND p.code = :pool"
        ),
        {"portion": "PROFIT", "pool": "HJ_PROFIT"},
    )
    _rewrite_option_json("downgrade")
    # 代分期表单字段（23 行，含锁定态与排序）不随 downgrade 复原：
    # 功能已下线，回滚只为保留数据结构，字段配置以当前 head 为准。
