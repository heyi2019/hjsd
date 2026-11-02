"""新增核算属性 ADDITIONAL_EXPENSE（附加支出）。

业务背景：成交环节存在「代同行收取后转付」的资金——客户按挂价全额付款，
其中一部分属于同行的分成，我方只是过手（如 HS0051 成交 888，转付同行 277.60）。
这类支出既不是号价成本（SELF_DIRECT_COST），也不是日常运营费用（OPERATING_EXPENSE），
需要独立属性承载，才能让「附加费用 = 附加支出 + 附加收入」两侧对称可核。

涉及三处：
1. cashflow.accounting_attribute 的 CHECK 约束（放开 → 换值 → 收紧）
2. option_sets 中 FUND_FLOW_ACCOUNTING_ATTRIBUTE 的选项值（插到「附加收入」之后）
3. 计价口径无需改动：属性只影响资金侧归类，订单损益仍由事件（SELL/BUY/COST）计算

幂等：重复执行不报错、不重复插选项。
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql.naming import conv

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

NEW = "ADDITIONAL_EXPENSE"
NEW_LABEL = "附加支出"
FALLBACK = "SELF_DIRECT_COST"
CHECK_NAME = "ck_cashflow_cashflow_accounting_attribute_valid"

# 现有枚举清单，与 app/domain/enums.py::AccountingAttribute 保持一致
_EXISTING = (
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

# 新属性插在「附加收入」之后，保持收入/支出相邻
_ATTRIBUTES = _EXISTING[:6] + (NEW,) + _EXISTING[6:]
_ANCHOR = "ADDITIONAL_INCOME"


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
    name = _find_check("cashflow", "ACCOUNTING_ATTRIBUTE")
    if name is None:
        return None
    with op.batch_alter_table("cashflow", naming_convention={}) as batch_op:
        batch_op.drop_constraint(conv(name), type_="check")
    return name


def _create_check(values: tuple[str, ...]) -> None:
    expression = "accounting_attribute IN (" + ", ".join(f"'{v}'" for v in values) + ")"
    with op.batch_alter_table("cashflow", naming_convention={}) as batch_op:
        batch_op.create_check_constraint(conv(CHECK_NAME), expression)


def _load_options(bind) -> tuple[int, list] | None:
    row = bind.execute(
        sa.text("SELECT id, options FROM option_sets WHERE code = 'FUND_FLOW_ACCOUNTING_ATTRIBUTE'")
    ).first()
    if row is None:
        return None
    raw = row[1]
    options = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(options, list):
        return None
    return row[0], options


def _add_option() -> bool:
    bind = op.get_bind()
    loaded = _load_options(bind)
    if loaded is None:
        return False
    option_id, options = loaded
    if any(isinstance(item, dict) and item.get("value") == NEW for item in options):
        return False
    item = {"value": NEW, "label": NEW_LABEL}
    index = next(
        (
            i + 1
            for i, option in enumerate(options)
            if isinstance(option, dict) and option.get("value") == _ANCHOR
        ),
        len(options),
    )
    options.insert(index, item)
    bind.execute(
        sa.text("UPDATE option_sets SET options = :options WHERE id = :id"),
        {"options": json.dumps(options, ensure_ascii=False), "id": option_id},
    )
    return True


def _remove_option() -> bool:
    bind = op.get_bind()
    loaded = _load_options(bind)
    if loaded is None:
        return False
    option_id, options = loaded
    kept = [
        option
        for option in options
        if not (isinstance(option, dict) and option.get("value") == NEW)
    ]
    if len(kept) == len(options):
        return False
    bind.execute(
        sa.text("UPDATE option_sets SET options = :options WHERE id = :id"),
        {"options": json.dumps(kept, ensure_ascii=False), "id": option_id},
    )
    return True


def _move_rows(old: str, new: str) -> int:
    result = op.get_bind().execute(
        sa.text("UPDATE cashflow SET accounting_attribute = :new WHERE accounting_attribute = :old"),
        {"new": new, "old": old},
    )
    return result.rowcount or 0


def upgrade() -> None:
    dropped = _drop_check()
    _create_check(_ATTRIBUTES)
    option_added = _add_option()
    print(f"[0007] check={dropped or '(无)'} option_set={'是' if option_added else '否'}")


def downgrade() -> None:
    # 先收敛数据再收紧 CHECK：旧约束不认识 ADDITIONAL_EXPENSE，直接收紧会失败。
    dropped = _drop_check()
    moved = _move_rows(NEW, FALLBACK)
    _create_check(_EXISTING)
    option_removed = _remove_option()
    print(
        f"[0007] downgrade check={dropped or '(无)'} rows={moved} "
        f"option_set={'是' if option_removed else '否'}"
    )
