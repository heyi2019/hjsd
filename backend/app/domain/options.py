"""domain.options：通用选项词典（D 类筛选器 / 业务字典的单一事实源）。

可与 order_form_fields（表单字段配置）区分：本表面向「页面筛选项 / 业务字典」，
不绑定任何表单作用域；options 为 [{value,label}] 列表。纯字典类 editable=True
（可增删改值），后端死枚举类 editable=False（只读展示，值受后端 CHECK 约束）。
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import JSON, Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.base import Base
from app.domain.base import AuditMixin


class OptionSet(Base, AuditMixin):
    """通用选项词典：按 code 唯一标识一组选项。"""

    __tablename__ = "option_sets"
    __table_args__ = (
        sa.Index("ix_option_sets_group", "group"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    group: Mapped[str] = mapped_column(String(64), nullable=False, server_default="GENERAL")
    # editable=False 表示后端死枚举（只读，值受 CHECK 约束），True 为纯字典可增删改
    editable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa.true()
    )
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


__all__ = ["OptionSet"]
