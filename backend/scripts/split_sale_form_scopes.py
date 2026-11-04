"""把历史单作用域 SALE 的售出表单配置拆成三份独立作用域（幂等、可重跑）。

背景：回收售出 / 提号售出 / 代挂售出原先共用 ``SALE`` 一套字段定义；改为
``SALEREC`` / ``SALETH`` / ``SALEDG`` 三份后，新库由 ``catalog_seed`` 直接播种，
已有库（dev / release / 生产）需要本脚本把管理员对 SALE 的既有配置复制到三份，
避免升级后三张表单字段标签、必填、启停态被重置为硬编码默认值。
三份字段集已按各自界面差异化，复制时只保留目标作用域仍存在的字段键。

纪律：只插入缺失行，不更新、不删除任何现有行；SALE 原行保留以便回滚。

用法：cd backend && .venv/bin/python3 scripts/split_sale_form_scopes.py
"""
from __future__ import annotations

import base64
import json
import os
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.domain.trade_models.form_config import (  # noqa: E402
    OrderFormField,
    OrderFormSectionLabel,
)
from app.foundation.catalog_seed import _CATALOG_BLOB, seed_catalog  # noqa: E402

NEW_SCOPES = ("SALEREC", "SALETH", "SALEDG")
LEGACY_SCOPE = "SALE"
_SKIP_COLUMNS = {"id", "created_at", "updated_at"}
FIELD_COLUMNS = [
    column.name
    for column in OrderFormField.__table__.columns
    if column.name not in _SKIP_COLUMNS and not column.primary_key
]


# 历史 SALE 内置字段的默认值（label, required, is_active, sort_order, section）。
# 只有与默认值不同的行才算「管理员改过」，才复制；未改过的行交给 seed_catalog
# 按新的差异化种子播种，否则代挂的「利润」会被旧默认值「售出金额」盖回。
LEGACY_DEFAULTS: dict[str, tuple[str, bool, bool, int, str]] = {
    "bound_phone": ("换绑手机号", False, True, 1010, "DELIVER"),
    "bound_phone_owner": ("手机号绑定人", False, True, 1020, "DELIVER"),
    "amount": ("售出金额", True, True, 2010, "FINANCE"),
    "payment_method": ("付款方式", False, True, 2020, "FINANCE"),
    "pool_id": ("资金账户", True, True, 2030, "FINANCE"),
    "down_payment": ("首付金额", False, True, 2040, "FINANCE"),
    "service_fee": ("分期服务费总额", False, True, 2050, "FINANCE"),
    "periods": ("分期期数", False, True, 2060, "FINANCE"),
    "per_period_service_fee": ("每期服务费", False, True, 2070, "FINANCE"),
    "per_period": ("每期金额", True, True, 2080, "FINANCE"),
    "note": ("备注", False, True, 5010, "EXTRA"),
}


def _is_customized(row) -> bool:
    default = LEGACY_DEFAULTS.get(row.field_key)
    if default is None:  # 管理员自建字段，一律保留
        return True
    actual = (
        row.label,
        bool(row.required),
        bool(row.is_active),
        int(row.sort_order),
        row.section,
    )
    return actual != default


def _target_keys() -> dict[str, set[str]]:
    """活基线中每个售出作用域的合法字段键。

    三份字段集已差异化（代挂无分期/分笔字段），不能把历史 SALE 的 13 行
    无差别复制到三份，否则代挂配置页会重新出现用不到的字段。
    """
    data = json.loads(zlib.decompress(base64.b64decode(_CATALOG_BLOB)))
    return {
        scope: {
            row["field_key"]
            for row in data["order_form_fields"]
            if row["order_type_code"] == scope
        }
        for scope in NEW_SCOPES
    }


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
        targets = _target_keys()
        for scope in NEW_SCOPES:
            if _count(db, OrderFormField, scope) == 0:
                for row in legacy_fields:
                    if row.field_key not in targets[scope] or not _is_customized(row):
                        continue
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
