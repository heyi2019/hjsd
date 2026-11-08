"""domain.base：通用混入（时间戳 + 审计人）。

`audit_logs` 负责记录受控动作的**前后值**；此处只存行级创建/修改痕迹，
两者互补，不能互相替代（BAS-05-03）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.time import now_second


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

    自动任务写 `system`，保证责任人永不为空。
    """

    created_by: Mapped[str] = mapped_column(String(64), nullable=False, default="system")
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False, default="system")


__all__ = ["AuditMixin", "TimestampMixin"]
