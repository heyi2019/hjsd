"""移除订单草稿态（2026-10-13 用户裁决）

判定依据（第一性原理）：
1. 订单本身不挂任何金额，金额全在 `order_events`；草稿订单是零业务信息的空壳；
2. 实际使用中本地库 69/72 单常住 `DRAFT`，它不是「中间态」而是绝大多数订单的常态；
3. 各模块口径分裂：R1 库存报表把草稿计入活跃订单、返点归集却把草稿单排除在外，
   质量检测又包含它。一个「有时算有时不算」的状态不承载信息，只制造不一致。

变更后：订单创建即 `ACTIVE`，过账不再翻转状态（去掉 DRAFT→ACTIVE 副作用）。

数据影响：存量 `DRAFT` 行统一 UPDATE 为 `ACTIVE`，**必须在拷贝前执行**——
新表 CHECK 不含 DRAFT，先拷会被拒。
downgrade 只恢复结构兼容（CHECK 放回 DRAFT），**无法把 ACTIVE 行还原为 DRAFT**：
哪些行原本是草稿已不可考，这是用户知晓的不可逆数据变换。

结构对齐：沿用 0009 模式——从 ORM 元数据编译 CREATE TABLE（命名约束/索引/CHECK
全部以 ORM 为准），`alembic check` 零漂移；不碰引用方表（`_new_` 临时表不存在
RENAME 级联改写引用方外键的问题，参照 0009 而非 0005 的 `RENAME TO __old` 路径）。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text
from sqlalchemy.schema import CreateTable

from app.core.database import Base  # noqa: F401  注册全部 v1 表
from app.domain import foundation, history, parties, trade, users  # noqa: F401

revision = "0011_orders_drop_draft_status"
down_revision = "0010_drop_quality_issues"
branch_labels = None
depends_on = None

# ORM 编译出的状态 CHECK 片段（当前已移除 DRAFT）；downgrade 用它换回含 DRAFT 的旧片段。
# 断言存在再替换，避免 ORM/枚举再次变更后迁移静默建出错误约束。
_STATUS_CHECK_NOW = "('ACTIVE', 'COMPLETED', 'CANCELLED')"
_STATUS_CHECK_WITH_DRAFT = "('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED')"


def _rebuild_orders(bind, status_check: str) -> None:
    """建临时表 → 拷数据 → 删旧表 → 改名 → 重建索引（0009 同款流程）。"""
    orm_t = Base.metadata.tables["orders"]
    ddl = str(CreateTable(orm_t).compile(dialect=bind.dialect))
    assert _STATUS_CHECK_NOW in ddl, "ORM 编译结果里找不到订单状态 CHECK，迁移假设已失效"
    ddl = ddl.replace(_STATUS_CHECK_NOW, status_check)
    ddl = ddl.replace("CREATE TABLE orders (", "CREATE TABLE _new_orders (", 1)
    bind.execute(text("DROP TABLE IF EXISTS _new_orders"))
    bind.execute(text("PRAGMA foreign_keys=OFF"))
    bind.execute(text(ddl))
    # 这里使用当前 ORM 生成临时表，但降级路径上的旧 orders 表可能还没有
    # 后续迁移新增的字段；只复制实际存在的交集，避免历史回滚被未来字段绑死。
    source_columns = {
        row[1]
        for row in bind.execute(text("PRAGMA table_info(orders)"))
    }
    cols = ", ".join(c.name for c in orm_t.columns if c.name in source_columns)
    bind.execute(text(f"INSERT INTO _new_orders ({cols}) SELECT {cols} FROM orders"))
    bind.execute(text("DROP TABLE orders"))
    bind.execute(text("ALTER TABLE _new_orders RENAME TO orders"))
    # 索引必须放 RENAME 之后建：旧表（及其同名索引）已随 DROP 消失，
    # 早建会因同名索引已存在而静默跳过、随后被 DROP 带走（0009 踩过的坑）。
    for idx in orm_t.indexes:
        uniq = "UNIQUE " if idx.unique else ""
        cexpr = ", ".join(c.name for c in idx.columns)
        bind.execute(
            text(f"CREATE {uniq}INDEX IF NOT EXISTS {idx.name} ON orders ({cexpr})")
        )
    bind.execute(text("PRAGMA foreign_keys=ON"))


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("UPDATE orders SET status = 'ACTIVE' WHERE status = 'DRAFT'"))
    _rebuild_orders(bind, _STATUS_CHECK_NOW)


def downgrade() -> None:
    # 仅恢复结构兼容（旧代码可再写入 DRAFT）；数据不可逆，见模块 docstring
    _rebuild_orders(op.get_bind(), _STATUS_CHECK_WITH_DRAFT)
