"""把历史单作用域 SALE 的售出表单配置拆成三份独立作用域（幂等、可重跑）。

背景：回收售出 / 提号售出 / 代挂售出原先共用 ``SALE`` 一套字段定义；改为
``SALEREC`` / ``SALETH`` / ``SALEDG`` 三份后，新库由 ``catalog_seed`` 直接播种，
已有库（dev / release / 生产）需要本脚本把管理员对 SALE 的既有配置复制到三份，
避免升级后三张表单字段标签、必填、启停态被重置为硬编码默认值。

纪律：只插入缺失行，不更新、不删除任何现有行；SALE 原行保留以便回滚。

用法：cd backend && .venv/bin/python3 scripts/split_sale_form_scopes.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.domain.trade_models.form_config import (  # noqa: E402
    OrderFormField,
    OrderFormSectionLabel,
)
from app.foundation.catalog_seed import seed_catalog  # noqa: E402

NEW_SCOPES = ("SALEREC", "SALETH", "SALEDG")
LEGACY_SCOPE = "SALE"
_SKIP_COLUMNS = {"id", "created_at", "updated_at"}
FIELD_COLUMNS = [
    column.name
    for column in OrderFormField.__table__.columns
    if column.name not in _SKIP_COLUMNS and not column.primary_key
]


def _count(db, model, scope: str) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(model)
            .where(model.order_type_code == scope)
        )
        or 0
    )


def main() -> None:
    url = os.environ.get("DATABASE_URL") or None
    Session = get_session_factory(url)
    inserted_fields = 0
    inserted_labels = 0
    with Session() as db:
        legacy_fields = list(
            db.scalars(
                select(OrderFormField).where(
                    OrderFormField.order_type_code == LEGACY_SCOPE
                )
            )
        )
        legacy_labels = list(
            db.scalars(
                select(OrderFormSectionLabel).where(
                    OrderFormSectionLabel.order_type_code == LEGACY_SCOPE
                )
            )
        )
        for scope in NEW_SCOPES:
            if _count(db, OrderFormField, scope) == 0:
                for row in legacy_fields:
                    payload = {name: getattr(row, name) for name in FIELD_COLUMNS}
                    payload["order_type_code"] = scope
                    db.add(OrderFormField(**payload))
                    inserted_fields += 1
            if _count(db, OrderFormSectionLabel, scope) == 0:
                for row in legacy_labels:
                    db.add(
                        OrderFormSectionLabel(
                            order_type_code=scope,
                            section_key=row.section_key,
                            label=row.label,
                        )
                    )
                    inserted_labels += 1
        # 先让复制行在同一事务内可见：autoflush=False 时 seed_catalog 的判重查询
        # 看不到 pending 行，会重复插入同 (scope, field_key) 触发唯一约束。
        db.flush()
        # 无历史 SALE 行、或历史字段不全时，用活基线种子补齐（只插不覆盖）
        seed_catalog(db, actor="system")
        db.commit()
        summary = {
            scope: {
                "fields": _count(db, OrderFormField, scope),
                "section_labels": _count(db, OrderFormSectionLabel, scope),
            }
            for scope in NEW_SCOPES
        }
    print(f"复制字段行 {inserted_fields}，板块标题行 {inserted_labels}")
    print("三作用域现状：", summary)


if __name__ == "__main__":
    main()
