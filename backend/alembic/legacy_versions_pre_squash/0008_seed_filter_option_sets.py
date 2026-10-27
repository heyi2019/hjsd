"""seed_filter_option_sets：补种全站筛选器 / 状态字典到 option_sets。

用户裁决「先做筛选器（B+D）、统一进 option_sets、展示同步」。0007 只种子了库存与
资金流水共 7 项；本迁移补齐其余全站筛选器与状态字典共 26 项，覆盖客户 / 订单 /
分期 / 导入 / 策略 / 质量 / 资金 / 系统 八组。

分类判据（与盘点一致）：
- 有 DB CHECK 或 `domain/enums.py` 定义 → B 类死枚举，`editable=False`（只读，
  值受后端约束，只允许在设置页改 label）
- 两者皆无 → A 类纯字典，`editable=True`（可自由增删值）
  本批仅 `QUALITY_SEVERITY` 属 A 类（quality_issues.severity 无 CHECK、无枚举定义）。

label 严格对齐前端既有展示文案（labels.ts / format.ts / StatusTag.tsx / 各面板硬编码），
保证接入后界面文案零变化。

本迁移只插数据、不改表结构；幂等：已存在相同 code 则跳过。

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-10-26 11:00:00.000000

"""

from __future__ import annotations

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet

revision: str = 'a7b8c9d0e1f2'
down_revision: str | None = 'f6a7b8c9d0e1'
branch_labels: str | None = None
depends_on: str | None = None

# code -> (label, group, editable, description, options)
SEED: dict[str, tuple[str, str, bool, str, list[dict[str, str]]]] = {
    # ── 客户 / 合作方 / 需求 ────────────────────────────────
    "CUSTOMER_STATUS": (
        "客户状态",
        "CUSTOMER",
        False,
        "customers.status（CHECK 约束），客户列表状态筛选",
        [
            {"value": "ACTIVE", "label": "启用中"},
            {"value": "DISABLED", "label": "已拉黑"},
            {"value": "MERGED", "label": "已合并"},
        ],
    ),
    "COUNTERPARTY_STATUS": (
        "合作方状态",
        "CUSTOMER",
        False,
        "counterparties.status（CHECK 约束）。DISABLED 文案与前端现状一致（已拉黑）",
        [
            {"value": "ACTIVE", "label": "进行中"},
            {"value": "DISABLED", "label": "已拉黑"},
        ],
    ),
    "COUNTERPARTY_TYPE": (
        "合作方类型",
        "CUSTOMER",
        False,
        "counterparties.type（CHECK 约束）",
        [
            {"value": "PEER", "label": "同行"},
            {"value": "SUPPLIER", "label": "供货方"},
            {"value": "PLATFORM", "label": "平台"},
        ],
    ),
    "LEAD_STATUS": (
        "需求状态",
        "CUSTOMER",
        False,
        "customer_leads.status（CHECK 约束）",
        [
            {"value": "OPEN", "label": "未结算"},
            {"value": "CONVERTED", "label": "已转化"},
            {"value": "CLOSED", "label": "已关闭"},
        ],
    ),
    "LEAD_TYPE": (
        "需求类型",
        "CUSTOMER",
        False,
        "customer_leads.request_type（CHECK 约束）",
        [
            {"value": "FIND_ACCOUNT", "label": "找号"},
            {"value": "SELL_ACCOUNT", "label": "卖号"},
            {"value": "SPECIFIC_SEARCH", "label": "指定搜索"},
        ],
    ),
    # ── 订单 ───────────────────────────────────────────────
    "ORDER_STATUS": (
        "订单状态",
        "ORDER",
        False,
        "orders.status（CHECK 约束）",
        [
            {"value": "ACTIVE", "label": "进行中"},
            {"value": "COMPLETED", "label": "已完成"},
            {"value": "CANCELLED", "label": "已取消"},
        ],
    ),
    "ORDER_LINK_STATUS": (
        "订单关联状态",
        "ORDER",
        False,
        "orders.link_status（CHECK 约束），业务台账关联筛选",
        [
            {"value": "LINKED", "label": "已关联"},
            {"value": "UNLINKED", "label": "未关联"},
            {"value": "ORPHAN", "label": "孤儿单"},
            {"value": "UNLINKED_TRANSFER", "label": "单边划转未关联"},
        ],
    ),
    "REFUND_RESPONSIBILITY": (
        "退款责任方",
        "ORDER",
        True,
        "orders.refund_responsibility：退款弹窗责任方选项。无 CHECK、无后端枚举，可自由增删",
        [
            {"value": "COMPANY", "label": "公司"},
            {"value": "CUSTOMER", "label": "客户"},
            {"value": "CONSIGNOR", "label": "寄售方"},
            {"value": "PLATFORM", "label": "平台"},
            {"value": "OTHER", "label": "其他"},
        ],
    ),
    "ORDER_BUSINESS": (
        "订单业务类型",
        "ORDER",
        False,
        "业务台账类型筛选（回收/提号/代挂/代分期）",
        [
            {"value": "HS", "label": "回收"},
            {"value": "TH", "label": "提号"},
            {"value": "DG", "label": "代挂"},
            {"value": "DFQ", "label": "代分期"},
        ],
    ),
    "ORDER_BUSINESS_MODE": (
        "订单业务模式",
        "ORDER",
        False,
        "业务台账自营/分销筛选（BusinessMode）",
        [
            {"value": "SELF", "label": "自营"},
            {"value": "DISTRIBUTION", "label": "分销"},
        ],
    ),
    "ORDER_RELATION_TYPE": (
        "订单关联关系",
        "ORDER",
        False,
        "order_links.relation_type（CHECK 约束）",
        [
            {"value": "SOURCE", "label": "来源单"},
            {"value": "FOLLOW_UP", "label": "后续单"},
        ],
    ),
    # ── 分期 / 期次 / 押金 ─────────────────────────────────
    "INSTALLMENT_CONTRACT_TYPE": (
        "分期合约类型",
        "INSTALLMENT",
        False,
        "installments.contract_type（CHECK 约束）",
        [
            {"value": "STOCK_SALE", "label": "分期出售"},
            {"value": "ADVANCE_PURCHASE", "label": "代分期"},
            {"value": "PICKUP_SALE", "label": "提号分期"},
            {"value": "CONSIGNMENT_SALE", "label": "代挂分期"},
        ],
    ),
    "INSTALLMENT_STATUS": (
        "分期状态",
        "INSTALLMENT",
        False,
        "installments.status（CHECK 约束，8 值）",
        [
            {"value": "PENDING", "label": "待首付"},
            {"value": "ACTIVE", "label": "收款中"},
            {"value": "OVERDUE", "label": "逾期"},
            {"value": "SETTLED", "label": "已结清"},
            {"value": "DELIVERED", "label": "已交付"},
            {"value": "DEFAULTED", "label": "违约"},
            {"value": "CLOSED", "label": "已关闭"},
            {"value": "CANCELLED", "label": "已取消"},
        ],
    ),
    "SCHEDULE_STATUS": (
        "期次状态",
        "INSTALLMENT",
        False,
        "installment_schedules.status（CHECK 约束，5 值）",
        [
            {"value": "PENDING", "label": "待收"},
            {"value": "PARTIAL", "label": "部分收款"},
            {"value": "PAID", "label": "已收"},
            {"value": "OVERDUE", "label": "逾期"},
            {"value": "WAIVED", "label": "已减免"},
        ],
    ),
    "DEPOSIT_STATUS": (
        "押金状态",
        "INSTALLMENT",
        False,
        "deposits.status（CHECK 约束，5 值）",
        [
            {"value": "PAID", "label": "已付"},
            {"value": "PARTIALLY_RETURNED", "label": "部分退还"},
            {"value": "RETURNED", "label": "已退"},
            {"value": "LOST", "label": "已损失"},
            {"value": "CANCELLED", "label": "已取消"},
        ],
    ),
    # ── 导入 ───────────────────────────────────────────────
    "IMPORT_BATCH_STATUS": (
        "导入批次状态",
        "IMPORT",
        False,
        "import_batches.status（CHECK 约束，6 值）",
        [
            {"value": "DRAFT", "label": "草稿"},
            {"value": "MAPPED", "label": "已映射"},
            {"value": "COMMITTED", "label": "已确认"},
            {"value": "REJECTED", "label": "已拒绝"},
            {"value": "ROLLED_BACK", "label": "已回滚"},
            {"value": "CORRECTED", "label": "已更正"},
        ],
    ),
    "IMPORT_SOURCE_KIND": (
        "导入数据类型",
        "IMPORT",
        False,
        "import_batches.source_kind（CHECK 约束，与导入模板一一对应）",
        [
            {"value": "STANDARD_ORDER", "label": "订单"},
            {"value": "STANDARD_ACCOUNT", "label": "账号"},
            {"value": "STANDARD_CASHFLOW", "label": "资金流水"},
            {"value": "STANDARD_INSTALLMENT", "label": "分期"},
            {"value": "STANDARD_LEAD", "label": "需求"},
        ],
    ),
    # ── 经营规则 ───────────────────────────────────────────
    "POLICY_STATUS": (
        "规则版本状态",
        "POLICY",
        False,
        "policy_definitions.status / policy_versions.status（CHECK 约束）",
        [
            {"value": "DRAFT", "label": "草稿"},
            {"value": "ACTIVE", "label": "已发布"},
            {"value": "EXPIRED", "label": "已失效"},
            {"value": "SUPERSEDED", "label": "已被取代"},
        ],
    ),
    "POLICY_SCOPE_TYPE": (
        "规则适用范围",
        "POLICY",
        False,
        "policy_definitions.scope_type（CHECK 约束）。label 与前端 SCOPE_OPTIONS 对齐，表单与表格展示共用同一份",
        [
            {"value": "GLOBAL", "label": "全局"},
            {"value": "ORDER_TYPE", "label": "按业务类型"},
            {"value": "USER", "label": "按人员"},
            {"value": "POOL", "label": "按资金池"},
        ],
    ),
    # ── 质量 ───────────────────────────────────────────────
    "QUALITY_STATUS": (
        "质量问题状态",
        "QUALITY",
        False,
        "quality_issues.status（CHECK 约束）",
        [
            {"value": "OPEN", "label": "待处理"},
            {"value": "IN_PROGRESS", "label": "处理中"},
            {"value": "CLOSED", "label": "已关闭"},
        ],
    ),
    "QUALITY_SEVERITY": (
        "质量问题严重程度",
        "QUALITY",
        True,
        "quality_issues.severity：无 CHECK、无后端枚举，是全站唯一可自由增删值的纯字典",
        [
            {"value": "LOW", "label": "低"},
            {"value": "MEDIUM", "label": "中"},
            {"value": "HIGH", "label": "高"},
            {"value": "CRITICAL", "label": "严重"},
        ],
    ),
    # ── 资金 ───────────────────────────────────────────────
    "RECONCILIATION_STATUS": (
        "日对账状态",
        "FUND",
        False,
        "reconciliations.status（CHECK 约束）。注意 OPEN/RESOLVED 与质量域共用编码，仅对账调用点用此文案",
        [
            {"value": "OPEN", "label": "未核销"},
            {"value": "RESOLVED", "label": "已核销"},
        ],
    ),
    "REBATE_STATUS": (
        "返点状态",
        "FUND",
        False,
        "rebate_records.status（CHECK 约束）",
        [
            {"value": "OPEN", "label": "未结算"},
            {"value": "PARTIALLY_SETTLED", "label": "部分结算"},
            {"value": "SETTLED", "label": "已结清"},
            {"value": "VOID", "label": "失效"},
        ],
    ),
    "POOL_STATUS": (
        "资金池状态",
        "FUND",
        False,
        "pools.status（CHECK 约束）",
        [
            {"value": "ACTIVE", "label": "进行中"},
            {"value": "DISABLED", "label": "已停用"},
        ],
    ),
    "POOL_ACCOUNT_STATUS": (
        "资金池账户状态",
        "FUND",
        False,
        "pool_accounts.status（CHECK 约束）。label 与资金池账户列表现状文案（启用/停用）对齐",
        [
            {"value": "ACTIVE", "label": "启用"},
            {"value": "DISABLED", "label": "停用"},
        ],
    ),
    # ── 系统 / 人员 ────────────────────────────────────────
    "USER_ROLE": (
        "用户角色",
        "SYSTEM",
        False,
        "users.role（CHECK 约束）。角色决定权限矩阵，值不可增删，仅可改显示名",
        [
            {"value": "ADMIN", "label": "系统管理员"},
            {"value": "OPERATOR", "label": "业务经办人"},
            {"value": "FINANCE", "label": "财务"},
            {"value": "AUDITOR", "label": "审核人"},
            {"value": "VIEWER", "label": "查看人"},
        ],
    ),
    "OWNER_SCOPE": (
        "数据可见范围",
        "SYSTEM",
        False,
        "users.owner_scope（CHECK 约束）",
        [
            {"value": "SELF", "label": "本人"},
            {"value": "TEAM", "label": "团队"},
            {"value": "ALL", "label": "全部"},
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
        session.commit()
    finally:
        session.close()
