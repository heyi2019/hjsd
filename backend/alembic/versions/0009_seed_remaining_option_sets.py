"""seed_remaining_option_sets：补种第三批选项词典（主数据与后端枚举）到 option_sets。

0007 种子了库存 / 资金流水 7 项，0008 补种了全站筛选器与状态字典 26 项（共 34 项 9 组）。
本批补齐**剩余全部可配置字段**：主数据表单下拉（资金池用途 / 归属、业务类型资金性质、
资金路由份额与性质）与后端枚举镜像（佣金、订单角色、利润分配、违约处置、导入行状态、
实体类型、字段类型）共 13 项，并新增 FIELD 分组。落地后共 47 项 10 组。

分类判据（与 0008 一致，不得随意放宽）：
- 有 DB CHECK **或** `domain/enums.py` 定义 → B 类死枚举，`editable=False`
  （值受后端约束，只允许在设置页改 label）
- 两者皆无 → A 类纯字典，`editable=True`

⚠️ 本批 13 项**全部**为 False，包括 `POOL_TYPE`：虽然 `pools.pool_type` 列上没有 CHECK
（建表时漏加），但 `domain/enums.py.PoolType` 已定义且 `foundation/seeds.py` 依此播种，
故按判据归入死枚举。若要放开需先补 CHECK 或明确裁决，不要在此处静默改 editable。

label 严格对齐前端既有展示文案（labels.ts 各 LABEL 映射 / OrderTypesPanel / PoolsPanel /
InstallmentsPanel 硬编码），保证接入后界面文案零变化。

本迁移只插数据、不改表结构；幂等：已存在相同 code 则跳过。
另附 `RELABEL`：校正 0008 已种 `ORDER_RELATION_TYPE` 的 label（见该常量处说明）。

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-10-26 13:30:00.000000

"""

from __future__ import annotations

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet

revision: str = 'b8c9d0e1f2a3'
down_revision: str | None = 'a7b8c9d0e1f2'
branch_labels: str | None = None
depends_on: str | None = None

# code -> (label, group, editable, description, options)
SEED: dict[str, tuple[str, str, bool, str, list[dict[str, str]]]] = {
    # ── 资金池主数据 ────────────────────────────────────────
    "POOL_TYPE": (
        "资金池用途类型",
        "FUND",
        False,
        "pools.pool_type。虽无 DB CHECK，但 enums.PoolType 已定义且 seeds 依此播种，按判据归死枚举",
        [
            {"value": "INVEST", "label": "投资款"},
            {"value": "PROFIT", "label": "利润"},
            {"value": "OTHER", "label": "其他"},
        ],
    ),
    "POOL_OWNERSHIP": (
        "资金池归属",
        "FUND",
        False,
        "pools.ownership（CHECK 约束 + enums.PoolOwnership）。决定计入权益还是只计头寸",
        [
            {"value": "OWNED", "label": "自有"},
            {"value": "CUSTODY", "label": "代管"},
            {"value": "THIRD_PART", "label": "第三方"},
        ],
    ),
    # ── 业务类型 / 资金路由 ────────────────────────────────
    "CAPITAL_TYPE": (
        "资金性质",
        "ORDER",
        False,
        "order_type_defs.capital_type / orders.capital_type（CHECK 约束 + enums.CapitalType）",
        [
            {"value": "STOCK", "label": "库存型"},
            {"value": "ZERO", "label": "零本金型"},
            {"value": "CREDIT", "label": "分期业务"},
        ],
    ),
    "ROUTE_PORTION": (
        "资金份额",
        "ORDER",
        False,
        "order_type_pools.portion / order_events.portion（CHECK 约束 + enums.Portion）",
        [
            {"value": "PRINCIPAL", "label": "本金"},
            {"value": "PROFIT", "label": "利润"},
            {"value": "GROSS", "label": "总额"},
        ],
    ),
    "ROUTE_FUND_NATURE": (
        "路由资金性质",
        "ORDER",
        False,
        "order_type_pools.fund_nature（CHECK 约束 + enums.FundNature）。不填表示不限性质",
        [
            {"value": "BUSINESS", "label": "本方经营"},
            {"value": "EXTERNAL", "label": "外部/受托"},
            {"value": "INTERNAL", "label": "内部调拨"},
        ],
    ),
    "COMMISSION_PAYER": (
        "佣金承担方",
        "ORDER",
        False,
        "orders.commission_payer（CHECK 约束 + enums.CommissionPayer）。仅代挂单可用，与佣金支付方式成对出现",
        [
            {"value": "BUYER", "label": "买方"},
            {"value": "CONSIGNOR", "label": "寄售方"},
            {"value": "PLATFORM", "label": "平台"},
        ],
    ),
    "COMMISSION_MODE": (
        "佣金支付方式",
        "ORDER",
        False,
        "orders.commission_mode（CHECK 约束 + enums.CommissionMode）",
        [
            {"value": "DEDUCT_FROM_SETTLEMENT", "label": "结算扣减"},
            {"value": "SEPARATE_PAYMENT", "label": "单独支付"},
        ],
    ),
    "ORDER_CUSTOMER_ROLE": (
        "订单客户角色",
        "ORDER",
        False,
        "order_customer_roles.role（CHECK 约束 + enums.CustomerRole）",
        [
            {"value": "SELLER", "label": "卖方"},
            {"value": "BUYER", "label": "买方"},
            {"value": "CONSIGNOR", "label": "寄售方"},
            {"value": "INSTALLMENT_CUSTOMER", "label": "分期客户"},
        ],
    ),
    "PROFIT_ROLE": (
        "利润分配角色",
        "ORDER",
        False,
        "order_profit_allocations.role（CHECK 约束 + enums.AllocationRole）",
        [
            {"value": "OWNER", "label": "业绩归属人"},
            {"value": "BUYER", "label": "买方"},
            {"value": "SALES", "label": "销售"},
            {"value": "SERVICE", "label": "服务"},
        ],
    ),
    # ── 分期 ───────────────────────────────────────────────
    "INSTALLMENT_DISPOSITION": (
        "违约处置方式",
        "INSTALLMENT",
        False,
        "installment_dispositions.action（CHECK 约束）。违约后账号的两种去向",
        [
            {"value": "RECOVER", "label": "回收"},
            {"value": "RESELL", "label": "出售"},
        ],
    ),
    # ── 导入 ───────────────────────────────────────────────
    "IMPORT_ROW_STATUS": (
        "导入行状态",
        "IMPORT",
        False,
        "import_rows.status（CHECK 约束 + enums.ImportRowStatus）",
        [
            {"value": "PENDING", "label": "待映射"},
            {"value": "MAPPED", "label": "已映射"},
            {"value": "UNMAPPED", "label": "未映射"},
            {"value": "IMPORTED", "label": "已导入"},
            {"value": "SKIPPED", "label": "已跳过"},
            {"value": "ROLLED_BACK", "label": "已回滚"},
        ],
    ),
    # ── 系统 / 元数据（新增 FIELD 分组）────────────────────
    "ENTITY_TYPE": (
        "实体类型",
        "SYSTEM",
        False,
        "field_definitions.entity_type / entity_extra_values.entity_type（CHECK 约束 + enums.EntityType）",
        [
            {"value": "order", "label": "订单"},
            {"value": "account", "label": "账号"},
            {"value": "customer", "label": "客户"},
            {"value": "installment", "label": "分期合约"},
            {"value": "pool", "label": "资金池"},
            {"value": "cashflow", "label": "资金流水"},
            {"value": "lead", "label": "需求"},
            {"value": "counterparty", "label": "合作方"},
        ],
    ),
    "FIELD_TYPE": (
        "字段类型",
        "FIELD",
        False,
        "field_definitions.field_type / order_form_fields.field_type（CHECK 约束 + enums.FieldType）",
        [
            {"value": "TEXT", "label": "文本"},
            {"value": "NUMBER", "label": "数字"},
            {"value": "DATE", "label": "日期"},
            {"value": "BOOLEAN", "label": "是/否"},
            {"value": "SELECT", "label": "单选"},
            {"value": "MULTI_SELECT", "label": "多选"},
        ],
    ),
}


# 对 0008 已种词典的 label 校正：code -> (新 options, 原 options)
# ORDER_RELATION_TYPE 在建关联弹窗里承担方向说明（"本单为其来源单（拆分出去的下游单）"），
# 0008 种的是短名（来源单/后续单），直接接入会让弹窗丢掉方向信息。这里把长措辞定为正本，
# 使前端接入后界面文案零变化。放在 0009 而不是回改已提交的 0008，避免重写历史迁移。
RELABEL: dict[str, tuple[list[dict[str, str]], list[dict[str, str]]]] = {
    "ORDER_RELATION_TYPE": (
        [
            {"value": "SOURCE", "label": "本单为其来源单（拆分出去的下游单）"},
            {"value": "FOLLOW_UP", "label": "本单为其后续单（承接来源单）"},
        ],
        [
            {"value": "SOURCE", "label": "来源单"},
            {"value": "FOLLOW_UP", "label": "后续单"},
        ],
    ),
}


def upgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        existing = set(session.scalars(select(OptionSet.code)).all())
        for code, (label, group, editable, description, options) in SEED.items():
            if code in existing:
                continue
            session.add(
                OptionSet(
                    code=code,
                    label=label,
                    group=group,
                    editable=editable,
                    options=options,
                    description=description,
                )
            )
        for code, (new_options, _old) in RELABEL.items():
            row = session.scalars(select(OptionSet).where(OptionSet.code == code)).first()
            if row is not None:
                row.options = new_options
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        for code in SEED:
            row = session.scalars(select(OptionSet).where(OptionSet.code == code)).first()
            if row is not None:
                session.delete(row)
        for code, (_new, old_options) in RELABEL.items():
            row = session.scalars(select(OptionSet).where(OptionSet.code == code)).first()
            if row is not None:
                row.options = old_options
        session.commit()
    finally:
        session.close()
