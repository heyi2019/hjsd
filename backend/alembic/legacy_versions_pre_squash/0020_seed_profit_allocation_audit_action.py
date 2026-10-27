"""seed_profit_allocation_audit_action：审计动作补 PROFIT_ALLOCATION_SET。

背景：`app/policy/service.py` 里 5 处审计写入原本**全部**写
`AuditAction.EXCEPTION_APPROVE`——含政策定义/版本创建、草稿配置更新，以及两种
分润设置。结果是审计页按「异常审批」筛选时会把政策变更与分润一起筛出来，
语义失真；而 `POLICY_CHANGE` 枚举早已存在却闲置。

本次把 3 处政策写入改指 `POLICY_CHANGE`，2 处分润改指新增的
`PROFIT_ALLOCATION_SET`。`audit_logs.action` 无 CHECK 约束，新增枚举值本身
不需要迁移；但审计面板的动作下拉 label 由 `option_sets.AUDIT_ACTION` 词典承载，
词典缺项会导致前端回落英文原值，故这里补种。

历史 33 条 `EXCEPTION_APPROVE` 记录不回填（当时的动作就是那样写的，回填会伪造
追溯链）；需要时按本迁移的 downgrade 语义反向理解。

Revision ID: 6caeeacd7625
Revises: f7a8b9c0d1e2
Create Date: 2026-10-27 13:20:00.000000

"""
from __future__ import annotations

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet

revision: str = "6caeeacd7625"
down_revision: str | None = "f7a8b9c0d1e2"
branch_labels: str | None = None
depends_on: str | None = None

SET_CODE = "AUDIT_ACTION"
NEW_OPTION = {"value": "PROFIT_ALLOCATION_SET", "label": "设置利润分润"}
# 插在 POLICY_CHANGE 之后，保持「规则类」动作聚在一起。
ANCHOR = "POLICY_CHANGE"


def upgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        row = session.scalars(select(OptionSet).where(OptionSet.code == SET_CODE)).first()
        if row is None:
            # 词典未种（极小概率的裁剪库）：枚举值本身已可用，前端按兜底常量渲染。
            return
        options = list(row.options or [])
        if any(item.get("value") == NEW_OPTION["value"] for item in options):
            return
        index = next(
            (i + 1 for i, item in enumerate(options) if item.get("value") == ANCHOR),
            len(options),
        )
        options.insert(index, dict(NEW_OPTION))
        row.options = options
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        row = session.scalars(select(OptionSet).where(OptionSet.code == SET_CODE)).first()
        if row is None:
            return
        options = [item for item in (row.options or []) if item.get("value") != NEW_OPTION["value"]]
        row.options = options
        session.commit()
    finally:
        session.close()
