"""核算属性 REBATE_INCOME 更名为 ADDITIONAL_INCOME（附加收入）。

改名原因：该属性实际承载的已不止返点——打赏(TIP)、违约金(PENALTY) 同归此类，
旧名「返点收入」语义过窄。改后口径为「附加收入 = 返点收入 + 其他收入」，
内部区分靠 cashflow.category（REBATE / TIP / PENALTY 等）。

涉及三处：
1. cashflow.accounting_attribute 的 CHECK 约束（放开 → 换值 → 收紧）
2. cashflow 存量数据（当前 31 笔）
3. option_sets 中 FUND_FLOW_ACCOUNTING_ATTRIBUTE 的选项值

幂等：重复执行不报错、不重复改。
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql.naming import conv

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

OLD = "REBATE_INCOME"
NEW = "ADDITIONAL_INCOME"
CHECK_NAME = "ck_cashflow_cashflow_accounting_attribute_valid"

# 改名后的完整枚举清单，与 app/domain/enums.py::AccountingAttribute 保持一致
_ATTRIBUTES = (
    "SELF_REVENUE",
    "SELF_DIRECT_COST",
    "TH_DIRECT_COST",
    "TH_REVENUE",
    "SERVICE_REVENUE",
    "ADDITIONAL_INCOME",
    "OPERATING_EXPENSE",
    "DEPOSIT",
    "EXTERNAL_FUNDING",
    "INTERNAL_TRANSFER",
    "REVERSAL",
    "REFUND",
)


def _find_check(table_name: str, *tokens: str) -> str | None:
    inspector = sa.inspect(op.get_bind())
    wanted = tuple(token.upper() for token in tokens)
    for constraint in inspector.get_check_constraints(table_name):
        name = constraint.get("name")
        sqltext = (constraint.get("sqltext") or "").upper()
        if name and all(token in sqltext for token in wanted):
            return name
    return None


def _drop_check() -> str | None:
    """删掉引用 accounting_attribute 的 CHECK，返回实际删除的约束名。"""
    name = _find_check("cashflow", "ACCOUNTING_ATTRIBUTE")
    if name is None:
        return None
    with op.batch_alter_table("cashflow", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(name), type_="check")
    return name


def _create_check() -> None:
    expression = "accounting_attribute IN (" + ", ".join(f"'{v}'" for v in _ATTRIBUTES) + ")"
    with op.batch_alter_table("cashflow", naming_convention={}) as batch_op:
        batch_op.create_check_constraint(conv(CHECK_NAME), expression)


def _rename_rows(old: str, new: str) -> int:
    bind = op.get_bind()
    result = bind.execute(
        sa.text("UPDATE cashflow SET accounting_attribute = :new WHERE accounting_attribute = :old"),
        {"new": new, "old": old},
    )
    return result.rowcount or 0


def _rename_option_set(old: str, new: str, new_label: str) -> bool:
    """把选项集里的旧值改成新值；已是新值则不动。"""
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT id, options FROM option_sets WHERE code = 'FUND_FLOW_ACCOUNTING_ATTRIBUTE'")
    ).first()
    if row is None:
        return False
    raw = row[1]
    options = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(options, list):
        return False

    changed = False
    for item in options:
        if isinstance(item, dict) and item.get("value") == old:
            item["value"] = new
            item["label"] = new_label
            changed = True
    if not changed:
        return False

    bind.execute(
        sa.text("UPDATE option_sets SET options = :options WHERE id = :id"),
        {"options": json.dumps(options, ensure_ascii=False), "id": row[0]},
    )
    return True


def upgrade() -> None:
    dropped = _drop_check()
    renamed = _rename_rows(OLD, NEW)
    _create_check()
    option_changed = _rename_option_set(OLD, NEW, "附加收入")
    print(f"[0004] check={dropped or '(无)'} rows={renamed} option_set={'是' if option_changed else '否'}")


def downgrade() -> None:
    _drop_check()
    _rename_rows(NEW, OLD)
    _create_check()
    _rename_option_set(NEW, OLD, "返点收入")
