"""merge_extra_fields_single_table：扩展字段单表化（活字段定义/值两表下线）。

用户裁决「彻底合并，用一个表」：

- **定义**并入 ``order_form_fields``（作用域 ``CUSTOMER``，``is_custom=1``）。
  客户建档表单的自定义字段即扩展字段，设置页「表单字段」统一维护。
- **值**并入 ``customers.form_extra``（JSON 列），与 ``Order.form_extra`` 同构，
  一实体一行，不再单独建值表。
- 下线 ``field_definitions`` 与 ``entity_extra_values`` 两张表。

升级前数据实况（dev 库实证）：``field_definitions`` 8 行、全部 ``entity_type='customer'``；
``entity_extra_values`` 0 行。迁移仍写足搬运逻辑，保证其他环境不漏数据。

Revision ID: 14bcd3e5f6a7
Revises: 13aab2c3d4e5
Create Date: 2026-10-26 22:05:00.000000

"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision: str = "14bcd3e5f6a7"
down_revision: str | None = "13aab2c3d4e5"
branch_labels: str | None = None
depends_on: str | None = None

CUSTOMER_SCOPE = "CUSTOMER"

# 客户建档的扩展字段（原 field_definitions 运行时数据，此处转为迁移种子，
# 保证任何新建库都自带这 8 项；sort_order 取 1010+ 与预置字段 10~60 分区）。
CUSTOMER_EXTRA_FIELDS: list[tuple[str, str, str, list[str] | None, bool, int]] = [
    ("trade_role", "交易角色", "SELECT", ["买家", "卖家", "货源", "中介"], False, 1010),
    ("game_category", "常玩品类", "MULTI_SELECT", ["王者荣耀", "和平精英", "原神", "英雄联盟", "其他"], False, 1020),
    ("credit_level", "信用评级", "SELECT", ["优质", "普通", "观察", "黑名单"], False, 1030),
    ("referrer", "转介绍人", "TEXT", None, False, 1040),
    ("with_compensation", "是否包赔", "BOOLEAN", None, False, 1050),
    ("recovery_record", "找回记录", "SELECT", ["无", "已找回", "协商中", "已赔付"], False, 1060),
    ("payment_consistency", "付款一致性", "SELECT", ["一致", "偶发不一致", "不一致"], False, 1070),
    ("settle_preference", "结算偏好", "SELECT", ["即时", "周结", "月结"], False, 1080),
]
ENTITY_TYPE_CHECK = (
    "entity_type IN ('order', 'account', 'customer', 'installment', "
    "'pool', 'cashflow', 'lead', 'counterparty')"
)


def _tables() -> set[str]:
    return set(inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _tables()
    bind = op.get_bind()

    # 1. customers.form_extra：扩展值落客户行
    if "customers" in tables:
        columns = {col["name"] for col in inspect(bind).get_columns("customers")}
        if "form_extra" not in columns:
            op.add_column("customers", sa.Column("form_extra", sa.JSON(), nullable=True))

    # 2. 旧值表 → customers.form_extra（按 field_key 聚合，已有键不覆盖）
    if "entity_extra_values" in tables and "field_definitions" in tables:
        rows = bind.execute(
            sa.text(
                "SELECT v.entity_id, d.field_key, v.value "
                "FROM entity_extra_values v "
                "JOIN field_definitions d ON d.id = v.field_definition_id "
                "WHERE v.entity_type = 'customer' "
                "ORDER BY v.id"
            )
        ).all()
        merged: dict[int, dict[str, object]] = {}
        for entity_id, field_key, value in rows:
            bucket = merged.setdefault(int(entity_id), {})
            bucket.setdefault(field_key, _unwrap(value))
        for customer_id, extras in merged.items():
            current = bind.execute(
                sa.text("SELECT form_extra FROM customers WHERE id = :id"),
                {"id": customer_id},
            ).scalar()
            base = dict(current or {})
            for key, value in extras.items():
                base.setdefault(key, value)
            bind.execute(
                sa.text("UPDATE customers SET form_extra = :extra WHERE id = :id"),
                {"extra": json.dumps(base), "id": customer_id},
            )

    # 3. 旧定义 → order_form_fields（CUSTOMER 作用域，自定义字段）
    if "field_definitions" in tables:
        session = Session(bind=bind)
        try:
            definitions = session.execute(
                sa.text(
                    "SELECT field_key, label, field_type, options, required, sort_order, is_active "
                    "FROM field_definitions WHERE entity_type = 'customer' "
                    "ORDER BY sort_order, id"
                )
            ).all()
            existing = {
                row.field_key
                for row in session.scalars(
                    select(OrderFormField).where(
                        OrderFormField.order_type_code == CUSTOMER_SCOPE
                    )
                )
            }
            for field_key, label, field_type, options, required, sort_order, is_active in definitions:
                if field_key in existing:
                    continue
                existing.add(field_key)
                session.add(
                    OrderFormField(
                        order_type_code=CUSTOMER_SCOPE,
                        field_key=field_key,
                        label=label,
                        field_type=field_type or "TEXT",
                        options=options,
                        required=bool(required),
                        is_active=bool(is_active),
                        # 自定义字段排在预置字段（10~60）之后，避免同一作用域内序号相撞。
                        sort_order=int(sort_order or 0) + 1000,
                        locked=False,
                        is_custom=True,
                        created_by="system",
                        updated_by="system",
                    )
                )
            # 种子兜底：旧库若已清空定义，仍保证客户扩展字段齐备
            for field_key, label, field_type, options, required, sort_order in CUSTOMER_EXTRA_FIELDS:
                if field_key in existing:
                    continue
                session.add(
                    OrderFormField(
                        order_type_code=CUSTOMER_SCOPE,
                        field_key=field_key,
                        label=label,
                        field_type=field_type,
                        options=options,
                        required=required,
                        is_active=True,
                        sort_order=sort_order,
                        locked=False,
                        is_custom=True,
                        created_by="system",
                        updated_by="system",
                    )
                )
            session.commit()
        finally:
            session.close()

    # 4. 下线两张旧表（先删值表，再删被其外键引用的定义表）
    if "entity_extra_values" in _tables():
        op.drop_table("entity_extra_values")
    if "field_definitions" in _tables():
        op.drop_table("field_definitions")


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        # 1. 重建定义表（与 0001 完全一致的 DDL）
        op.create_table(
            "field_definitions",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("entity_type", sa.String(length=32), nullable=False),
            sa.Column("field_key", sa.String(length=64), nullable=False),
            sa.Column("label", sa.String(length=128), nullable=False),
            sa.Column("field_type", sa.String(length=16), nullable=False),
            sa.Column("options", sa.JSON(), nullable=True),
            sa.Column("option_set_code", sa.String(length=64), nullable=True),
            sa.Column("default_value", sa.JSON(), nullable=True),
            sa.Column("applicable_order_types", sa.JSON(), nullable=True),
            sa.Column("validation_rule", sa.JSON(), nullable=True),
            sa.Column("required", sa.Boolean(), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False),
            sa.Column("created_by", sa.String(length=64), nullable=False),
            sa.Column("updated_by", sa.String(length=64), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.CheckConstraint(ENTITY_TYPE_CHECK, name=op.f("ck_field_definitions_field_entity_valid")),
            sa.CheckConstraint(
                "field_type IN ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT')",
                name=op.f("ck_field_definitions_field_type_valid"),
            ),
            sa.CheckConstraint("sort_order >= 0", name=op.f("ck_field_definitions_field_sort_order_nonnegative")),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_field_definitions")),
            sa.UniqueConstraint("entity_type", "field_key", name="uq_field_definitions_key"),
        )

        # 2. 自定义字段回填为活字段定义
        session.execute(
            sa.text(
                "INSERT INTO field_definitions ("
                "entity_type, field_key, label, field_type, options, required, sort_order, "
                "is_active, created_by, updated_by) "
                "SELECT 'customer', field_key, label, field_type, options, required, sort_order, "
                "is_active, 'system', 'system' FROM order_form_fields "
                "WHERE order_type_code = 'CUSTOMER' AND is_custom = 1"
            )
        )

        # 回填后不再保留表单侧的自定义字段，恢复「定义只在 field_definitions」的旧形态，
        # 保证「upgrade → downgrade → upgrade」可重复执行且不残留重复定义。
        session.execute(
            sa.text(
                "DELETE FROM order_form_fields "
                "WHERE order_type_code = 'CUSTOMER' AND is_custom = 1"
            )
        )

        # 3. 重建值表（与 0001 一致）
        op.create_table(
            "entity_extra_values",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("entity_type", sa.String(length=32), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=False),
            sa.Column("field_definition_id", sa.Integer(), nullable=False),
            sa.Column("value", sa.JSON(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.CheckConstraint(
                ENTITY_TYPE_CHECK,
                name=op.f("ck_entity_extra_values_extra_value_entity_valid"),
            ),
            sa.ForeignKeyConstraint(
                ["field_definition_id"],
                ["field_definitions.id"],
                name=op.f("fk_entity_extra_values_field_definition_id"),
                ondelete="RESTRICT",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_entity_extra_values")),
            sa.UniqueConstraint(
                "entity_type", "entity_id", "field_definition_id",
                name="uq_entity_extra_values_unique",
            ),
        )
        op.create_index(
            "ix_entity_extra_values_field_definition_id",
            "entity_extra_values",
            ["field_definition_id"],
            unique=False,
        )

        # 4. customers.form_extra 回填为值表行
        for customer_id, form_extra in bind.execute(
            sa.text("SELECT id, form_extra FROM customers WHERE form_extra IS NOT NULL")
        ).all():
            for field_key, value in dict(form_extra or {}).items():
                definition_id = bind.execute(
                    sa.text(
                        "SELECT id FROM field_definitions "
                        "WHERE entity_type = 'customer' AND field_key = :key"
                    ),
                    {"key": field_key},
                ).scalar()
                if definition_id is None:
                    continue
                bind.execute(
                    sa.text(
                        "INSERT OR IGNORE INTO entity_extra_values "
                        "(entity_type, entity_id, field_definition_id, value) "
                        "VALUES ('customer', :entity_id, :definition_id, :value)"
                    ),
                    {
                        "entity_id": customer_id,
                        "definition_id": definition_id,
                        "value": json.dumps({"value": value}),
                    },
                )
        session.commit()
    finally:
        session.close()

    # 5. 去掉 customers.form_extra
    with op.batch_alter_table("customers") as batch_op:
        batch_op.drop_column("form_extra")


def _unwrap(value: object) -> object:
    """旧值表把真实值包在 {"value": ...} 里。"""
    if isinstance(value, dict) and "value" in value:
        return value["value"]
    return value
