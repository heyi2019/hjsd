"""0005 客户来源「可输入选填」配置对齐（2026-10-28 用户裁决：全修）。

背景：早前前端已把「客户来源」从 SELECT 改为可输入（普通 Input）+ 选填 + 砍掉 _other 分支，
但后端 order_form_fields 配置未同步 —— DG/DFQ 的 customer_source 仍是 required=1 + SELECT + 带 _other 死行，
导致 DG/DFQ 建单被强制要求填客户来源，与 HS 不一致的选填意图冲突。

本次修正（配置为最终口径，遵循 ConfigurableField.resolveRules）：
- customer_source / dg_customer_source / dfq_customer_source 三个字段统一：required=0、field_type=TEXT、options=NULL
  （UI 已用普通 Input 渲染，SELECT 类型与预设选项、_other 分支均为死配置）。
- 删除 dg_customer_source_other / customer_source_other 两条死行（UI 已不渲染 _other 分支）。
"""
from __future__ import annotations

from sqlalchemy import text

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

# 原始预设选项（仅 downgrade 还原用）
_SRC_OPTIONS = (
    '[{"value": "自营", "label": "自营"}, '
    '{"value": "微博", "label": "微博"}, '
    '{"value": "小红书", "label": "小红书"}, '
    '{"value": "闲鱼", "label": "闲鱼"}, '
    '{"value": "同行推荐", "label": "同行推荐"}, '
    '{"value": "其他", "label": "其他"}]'
)


def upgrade() -> None:
    bind = op.get_bind()
    # 1) 三个 customer_source 统一为「可输入选填」：必填关、文本型、清空死选项。
    bind.execute(
        text(
            "UPDATE order_form_fields "
            "SET required = 0, field_type = 'TEXT', options = NULL "
            "WHERE field_key IN ('customer_source', 'dg_customer_source', 'dfq_customer_source')"
        )
    )
    # 2) 删除 _other 死行（UI 已砍 _other 分支，不再渲染）。
    bind.execute(
        text(
            "DELETE FROM order_form_fields "
            "WHERE field_key IN ('customer_source_other', 'dg_customer_source_other')"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    # 1) 还原三字段原始状态（HS 原即 required=0；DG/DFQ 原为 required=1；均为 SELECT + 预设选项）。
    bind.execute(
        text(
            "UPDATE order_form_fields SET required = 0, field_type = 'SELECT', options = :opts "
            "WHERE field_key = 'customer_source'"
        ),
        {"opts": _SRC_OPTIONS},
    )
    bind.execute(
        text(
            "UPDATE order_form_fields SET required = 1, field_type = 'SELECT', options = :opts "
            "WHERE field_key = 'dg_customer_source'"
        ),
        {"opts": _SRC_OPTIONS},
    )
    bind.execute(
        text(
            "UPDATE order_form_fields SET required = 1, field_type = 'SELECT', options = :opts "
            "WHERE field_key = 'dfq_customer_source'"
        ),
        {"opts": _SRC_OPTIONS},
    )
    # 2) 还原两条 _other 死行（保留原 id 与依赖关系，便于后续再次删除时无主键冲突）。
    bind.execute(
        text(
            "INSERT INTO order_form_fields "
            "(id, order_type_code, field_key, label, field_type, options, required, is_active, "
            " sort_order, locked, is_custom, note, created_by, updated_by, created_at, updated_at, "
            " required_when) "
            "VALUES (10, 'HS', 'customer_source_other', '其他来源', 'TEXT', NULL, 0, 1, 130, 0, 0, "
            " NULL, 'system', 'system', '2026-10-25 08:53:39', '2026-10-25 08:53:39', "
            " '{\"field\": \"customer_source\", \"op\": \"eq\", \"values\": [\"其他\"]}')"
        )
    )
    bind.execute(
        text(
            "INSERT INTO order_form_fields "
            "(id, order_type_code, field_key, label, field_type, options, required, is_active, "
            " sort_order, locked, is_custom, note, created_by, updated_by, created_at, updated_at, "
            " required_when) "
            "VALUES (65, 'DG', 'dg_customer_source_other', '其他来源', 'TEXT', NULL, 0, 1, 130, 0, 0, "
            " NULL, 'system', 'system', '2026-10-25 08:53:39', '2026-10-25 08:53:39', "
            " '{\"field\": \"dg_customer_source\", \"op\": \"eq\", \"values\": [\"其他\"]}')"
        )
    )
