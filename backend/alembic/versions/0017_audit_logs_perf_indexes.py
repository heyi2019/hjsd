"""audit_logs_perf_indexes：审计轨迹查询补齐索引。

背景：`audit_logs` 是全库增长最快的表（只追加、禁止编辑），上线以来一直是
**唯一没有二级索引的业务表**——审计页按「对象类型 / 对象 ID / 动作 / 操作人 /
时间范围」筛选时全表扫描，且 `ORDER BY id DESC LIMIT/OFFSET` 深翻页越翻越慢。

本次补 4 个索引，与 `app/domain/foundation.py::AuditLog.__table_args__` 一致：

- `ix_audit_logs_entity`  (entity_type, entity_id, id)：对象轨迹 + 按类型筛选，
  末列 id 让「类型内按时间倒序分页」走索引有序、免排序；
- `ix_audit_logs_action`  (action)：动作筛选（46 种取值，区分度足够）；
- `ix_audit_logs_actor`   (actor)：按操作人追溯；
- `ix_audit_logs_occurred_at` (occurred_at)：时间范围筛选。

纯增量：不删列、不改数据，downgrade 只删索引。

Revision ID: b417888133de
Revises: 16c8d9e0f1a2
Create Date: 2026-10-26 23:55:00.000000

"""

from __future__ import annotations

from sqlalchemy import inspect
from alembic import op

revision: str = "b417888133de"
down_revision: str | None = "16c8d9e0f1a2"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "audit_logs"

# (索引名, 列元组)
INDEXES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("ix_audit_logs_entity", ("entity_type", "entity_id", "id")),
    ("ix_audit_logs_action", ("action",)),
    ("ix_audit_logs_actor", ("actor",)),
    ("ix_audit_logs_occurred_at", ("occurred_at",)),
)


def _existing() -> set[str]:
    insp = inspect(op.get_bind())
    if TABLE not in insp.get_table_names():
        return set()
    return {ix["name"] for ix in insp.get_indexes(TABLE)}


def upgrade() -> None:
    existing = _existing()
    for name, columns in INDEXES:
        if name in existing:
            continue
        op.create_index(name, TABLE, list(columns))


def downgrade() -> None:
    existing = _existing()
    for name, _columns in INDEXES:
        if name not in existing:
            continue
        op.drop_index(name, table_name=TABLE)
