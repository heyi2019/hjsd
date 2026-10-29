"""domain.lists：列表列显示配置（哪些列显示、以什么顺序显示）+ 自定义列定义。

`ListColumnConfig` 只存「状态」不存「文案」：列清单与中文名以 `app.lists.scopes`
注册表为唯一事实源，本表按 (scope, column_key) 记录可见性与排序；缺行即默认可见
+ 按注册表顺序，因此后续新增列不需要写数据迁移，也不会因漏播种而「新列凭空消失」。

`ListCustomColumn` 存管理员在「设置 → 列表字段」里**新增的列**：它绑定一个表单自定义
字段（field_key），列值从行数据的 form_extra / extra_values 里按该键取。显示状态
（可见/顺序/列宽/固定）仍复用 `ListColumnConfig`，列键统一加 `extra:` 前缀以免与
注册表内置列撞名。恢复默认只清配置行，不删自定义列定义 —— 新增的列是配置资产，
要删必须显式删除。
"""
from __future__ import annotations

from sqlalchemy import JSON, Boolean, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.domain.base import AuditMixin


class ListColumnConfig(Base, AuditMixin):
    """某个列表（scope）下某列的显示状态与排序。"""

    __tablename__ = "list_column_configs"
    __table_args__ = (
        UniqueConstraint("scope", "column_key", name="uq_list_column_configs_scope_column"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scope: Mapped[str] = mapped_column(String(32), nullable=False)
    column_key: Mapped[str] = mapped_column(String(64), nullable=False)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 列宽与固定态：NULL = 不覆盖，沿用列定义自身的宽度/不固定。
    # 只存「覆盖值」，代码里调整默认列宽不会被历史配置锁死。
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fixed: Mapped[str | None] = mapped_column(String(8), nullable=True)


class ListCustomColumn(Base, AuditMixin):
    """某个列表下管理员新增的自定义列（数据来源 = 表单自定义字段）。"""

    __tablename__ = "list_custom_columns"
    __table_args__ = (
        UniqueConstraint("scope", "column_key", name="uq_list_custom_columns_scope_column"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scope: Mapped[str] = mapped_column(String(32), nullable=False)
    # 统一 `extra:{field_key}`，与注册表内置列命名空间隔离
    column_key: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    # 行数据 form_extra / extra_values 里的键
    source_key: Mapped[str] = mapped_column(String(64), nullable=False)
    # 字段类型快照（TEXT/NUMBER/SELECT/MULTI_SELECT/BOOLEAN/DATE），仅供展示参考
    field_type: Mapped[str] = mapped_column(String(16), nullable=False, default="TEXT")
    # 选项值 → 中文展示名快照（SELECT/MULTI_SELECT），渲染与导出共用
    value_labels: Mapped[dict | None] = mapped_column(JSON, nullable=True)


__all__ = ["ListColumnConfig", "ListCustomColumn"]
