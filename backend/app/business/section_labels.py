"""orders.section_labels：建单表单板块标题的读写（含核心板块锁定）。"""
from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Validation
from app.domain.enums import AuditAction
from app.domain.trade import OrderFormSectionLabel

from app.shared.form_field_rules import (
    ORDER_TYPE_CODE_PATTERN,
    _validate_section,
)
from app.domain.form_scopes import SCOPE_CODES

def get_section_labels(session: Session, *, order_type_code: str) -> dict[str, str]:
    """返回该业务类型下已自定义（落库）的板块标题映射：section_key -> 显示标题。

    仅返回被显式覆盖的板块；前端在无配置值时用硬编码 fallback 兜底，
    与字段标签 ``fieldLabel`` 的配置驱动机制保持一致。
    """
    code = (order_type_code or "").strip().upper()
    if not ORDER_TYPE_CODE_PATTERN.match(code):
        raise Validation(
            "表单作用域 code 必须为 2-16 位大写字母或数字",
            details={"field": "order_type_code", "value": order_type_code},
        )
    rows = session.scalars(
        select(OrderFormSectionLabel).where(OrderFormSectionLabel.order_type_code == code)
    )
    return {row.section_key: row.label for row in rows}


def save_section_labels(
    session: Session,
    *,
    order_type_code: str,
    labels: Mapping[str, str],
    actor: str,
) -> dict[str, str]:
    """upsert 板块标题：空标题视为「恢复默认」并删除对应覆盖行；非空标题写入/更新。

    返回保存后该业务类型的完整板块标题映射（仅含已覆盖项，其余由前端 fallback 兜底）。
    传入的 ``labels`` 即该作用域的目标映射，空标题会让对应板块恢复默认显示名。
    """
    code = (order_type_code or "").strip().upper()
    if not ORDER_TYPE_CODE_PATTERN.match(code):
        raise Validation(
            "表单作用域 code 必须为 2-16 位大写字母或数字",
            details={"field": "order_type_code", "value": order_type_code},
        )
    if code not in SCOPE_CODES:
        # 板块标题属于表单配置，作用域必须先在注册表登记；否则会写入前端
        # 永远读不到（scopes 接口不下发）、也无法被任何表单消费的僵尸配置。
        raise Validation(
            f"表单作用域 {code} 未按注册表登记",
            details={"field": "order_type_code", "value": order_type_code},
        )
    if not isinstance(labels, Mapping):
        raise Validation("labels 必须为对象", details={"field": "labels"})

    # 先统一校验所有 section_key 合法，避免部分写入导致的脏状态。
    normalized: dict[str, str] = {}
    for section_key, raw_label in labels.items():
        _validate_section(section_key)
        key = section_key.strip()
        label = "" if raw_label is None else str(raw_label).strip()
        normalized[key] = label

    existing = {
        row.section_key: row
        for row in session.scalars(
            select(OrderFormSectionLabel).where(OrderFormSectionLabel.order_type_code == code)
        )
    }

    for section_key, label in normalized.items():
        row = existing.get(section_key)
        if not label:
            # 空标题：恢复默认，删除既有覆盖行（若存在）。
            if row is not None:
                session.delete(row)
            continue
        if row is None:
            row = OrderFormSectionLabel(
                order_type_code=code,
                section_key=section_key,
                label=label,
                created_by=actor,
                updated_by=actor,
            )
            session.add(row)
        else:
            row.label = label
            row.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_FORM_FIELD_CHANGE,
        entity_type="order_form_section_label",
        entity_id=code,
        actor=actor,
        before=None,
        after={"labels": dict(normalized)},
    )
    return get_section_labels(session, order_type_code=code)
