"""建单表单字段与板块标题配置（BAS-04）。"""

from __future__ import annotations

import sqlalchemy as sa

from app.core.database import Base
from app.domain.base import AuditMixin
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import (
    Mapped,
    mapped_column,
)

class OrderFormField(Base, AuditMixin):
    """表单字段配置：按表单作用域码（建单 HS/TH/DG、客户建档 CUSTOMER 等）描述字段构成。

    全站唯一的字段定义来源，替代已下线的独立字段定义表（2026-10-26 合并）：
    本表描述表单字段的展示/必填/停用/排序，并可覆盖核心核算字段的必填态。核心核算字段
    （建单/过账强依赖）以 locked=True 保护，禁止删除，但仍可改必填/选填与停用
    （停用需业务侧自行承担过账风险，由前端提示）。

    field_key 与表单既有字段 name / 自定义字段键一一对应；自定义字段（is_custom=1）
    即扩展字段：建单账号/产品字段写入 Account.form_extra，订单级字段写入
    Order.form_extra，客户建档字段写入 Customer.form_extra。
    """

    __tablename__ = "order_form_fields"
    __table_args__ = (
        Index("ix_order_form_fields_code_sort", "order_type_code", "sort_order"),
        CheckConstraint(
            "field_type IN ('TEXT','NUMBER','DATE','BOOLEAN','SELECT','MULTI_SELECT')",
            name="order_form_field_type_valid",
        ),
        UniqueConstraint(
            "order_type_code", "field_key", name="uq_order_form_fields_code_key"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_type_code: Mapped[str] = mapped_column(String(16), nullable=False)
    field_key: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    field_type: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="TEXT"
    )
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # 资金字段的流向属性：IN=收入，OUT=支出；非资金字段为空。
    flow_direction: Mapped[str | None] = mapped_column(String(8), nullable=True)
    required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa.false()
    )
    # 条件必填：{"field": 依赖字段键, "op": "eq|ne|filled", "values": [触发值]}
    # 与 required 互斥（required=True 时忽略并清空）；为空即纯选填。
    required_when: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa.true()
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=sa.text("0")
    )
    locked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa.false()
    )
    is_custom: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa.false()
    )
    # 字段归属板块：账号/产品、客户/供货方、费用资金、业务方案、交付、运营、其他补充。
    section: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="EXTRA"
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class OrderFormSectionLabel(Base, AuditMixin):
    """表单板块标题配置：按业务类型与作用域板块键描述板块显示标题。

    设置面板「板块管理」可编辑板块显示名；订单建单表单的区块标题从此读取，
    实现「设置里改板块名 → 建单同步显示」与字段标签一致的配置驱动体验。
    板块键复用 order_form_fields.section 的值域（ACCOUNT_PRODUCT / FINANCE /
    PARTICIPANT / DELIVER / BUSINESS / OPERATION / EXTRA）。
    """

    __tablename__ = "order_form_section_labels"
    __table_args__ = (
        UniqueConstraint(
            "order_type_code", "section_key", name="uq_order_form_section_labels_code_key"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_type_code: Mapped[str] = mapped_column(String(16), nullable=False)
    section_key: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
