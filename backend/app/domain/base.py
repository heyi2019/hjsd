"""domain.base：ORM 声明基类 + 通用混入（时间戳 + 审计人）。

`audit_logs` 负责记录受控动作的**前后值**；此处只存行级创建/修改痕迹，
两者互补，不能互相替代（BAS-05-03）。

**Base 归属说明（2026-11-18 架构归位）**：
`Base` 原在 `app/core/database.py`，与 engine/session 同处 core 层。但 Base 是
**ORM 声明基类**，只有模型层需要它；而 core 层一旦反向依赖 domain，就形成
`core ↔ domain` 双向环（core 的 audit/numbering/security 等模块要读 ORM，
domain 的模型又要用 Base）。归位到 domain 层后：
- `domain` → `core` 单向（只用 settings/time/money 这类纯技术工具）；
- `core` 不再 import domain，彻底断环。

`create_all`（仅测试快速建库用）同步归位到 domain：它要访问 `Base.metadata`，
留在 core 会重新引入 core → domain 依赖。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, MetaData, String, func
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.time import now_second

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """全部领域模型的基类。"""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def create_all(url: str | None = None) -> Engine:
    """仅供测试快速建库；生产结构一律走 Alembic。

    归位到 domain 的原因：它要访问 `Base.metadata`，留在 core 会形成
    `core → domain` 依赖边（core ↔ domain 环的另一半）。
    """
    from app.core.database import get_engine

    engine = get_engine(url)
    Base.metadata.create_all(bind=engine)
    return engine


class TimestampMixin:
    """创建/更新时间由数据库时钟统一兜底，避免应用时钟漂移。"""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=now_second, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=now_second,
        server_default=func.now(),
        onupdate=now_second,
    )


class AuditMixin(TimestampMixin):
    """带操作人痕迹的通用混入。

    匿名用户（迁移/种子）写 `system`，保证责任人永不为空。
    """

    created_by: Mapped[str] = mapped_column(String(64), nullable=False, default="system")
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False, default="system")


__all__ = ["AuditMixin", "Base", "NAMING_CONVENTION", "TimestampMixin"]
