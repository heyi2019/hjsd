"""drop_pool_account_form_fields：清理已下线板块的残留字段定义。

背景：迁移 `0013_remove_pool_accounts`（rev 13aab2c3d4e5）已把「资金池账户」整个
板块下线（表、服务、端点、前端面板全部移除），前端 `FORM_SCOPES` 也早已断言
`not.toContain("POOLACCOUNT")`。但 `order_form_fields` 里仍留着该作用域的 2 条
字段定义（id 190 `account_type` / 191 `ownership`），属于**没有任何消费者**的
死数据：既不会被任何表单渲染，也不会被 `required_when` 引用（已核验无依赖）。

本次删除这 2 行。纯减量，downgrade 按原值插回（id 固定，可重复执行）。

Revision ID: c0d83a5e4f10
Revises: b417888133de
Create Date: 2026-10-26 23:59:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision: str = "c0d83a5e4f10"
down_revision: str | None = "b417888133de"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "order_form_fields"
SCOPE = "POOLACCOUNT"

# downgrade 用：删除前的原值快照（id 固定，保证重复执行幂等）
_ROWS: tuple[dict[str, object], ...] = (
    {
        "id": 190,
        "order_type_code": SCOPE,
        "field_key": "account_type",
        "label": "账户类型",
        "field_type": "SELECT",
        "options": (
            '[{"value": "BANK", "label": "银行账户"}, '
            '{"value": "CASH", "label": "现金"}, '
            '{"value": "THIRD_PARTY", "label": "第三方渠道"}]'
        ),
        "required": 1,
        "is_active": 1,
        "sort_order": 0,
        "locked": 1,
        "is_custom": 0,
        "note": None,
        "created_by": "system",
        "updated_by": "system",
        "created_at": "2026-10-26 01:01:54",
        "updated_at": "2026-10-26 01:01:54",
        "required_when": None,
    },
    {
        "id": 191,
        "order_type_code": SCOPE,
        "field_key": "ownership",
        "label": "归属",
        "field_type": "SELECT",
        "options": (
            '[{"value": "OWNED", "label": "自有（计入权益）"}, '
            '{"value": "CUSTODY", "label": "代管（只计头寸）"}, '
            '{"value": "THIRD_PART", "label": "第三方（只计头寸）"}]'
        ),
        "required": 1,
        "is_active": 1,
        "sort_order": 1,
        "locked": 1,
        "is_custom": 0,
        "note": None,
        "created_by": "system",
        "updated_by": "system",
        "created_at": "2026-10-26 01:01:54",
        "updated_at": "2026-10-26 01:01:54",
        "required_when": None,
    },
)


def upgrade() -> None:
    op.execute(
        sa.text(f"DELETE FROM {TABLE} WHERE order_type_code = :scope").bindparams(scope=SCOPE)
    )


def downgrade() -> None:
    conn = op.get_bind()
    for row in _ROWS:
        exists = conn.execute(
            sa.text(f"SELECT 1 FROM {TABLE} WHERE id = :id").bindparams(id=row["id"])
        ).fetchone()
        if exists:
            continue
        columns = ", ".join(row)
        placeholders = ", ".join(f":{key}" for key in row)
        conn.execute(
            sa.text(f"INSERT INTO {TABLE} ({columns}) VALUES ({placeholders})"),
            dict(row),
        )
