"""seed_remaining_option_sets_2：补种第四批选项词典，并合并实体类型取值。


0007 种了库存 / 资金流水 7 项，0008 补种全站筛选器与状态 26 项（34 项 9 组），
0009 补齐主数据与后端枚举 13 项（47 项 10 组）。本批再补 10 项，落地后 **57 项 12 组**，
新增 AUDIT 与 REPORT 两个分组。

新增（判据沿用 0008：有 DB CHECK 或 `domain/enums.py` 定义 → 死枚举 editable=False）：
  AUDIT_ACTION        audit_logs.action（enums.AuditAction 84 项）      —— 最大缺口
  ORDER_EVENT_TYPE    order_events.event_type（CHECK + enums.EventType）
  CASHFLOW_NATURE     cashflow.nature（CHECK + enums.Nature）
  DELIVERY_MODE       order_events/installments.delivery_mode（CHECK + enums.DeliveryMode）
  REBATE_TYPE         rebate_records.rebate_type（CHECK + enums.RebateType）
  POOL_ACCOUNT_TYPE   pool_accounts.account_type（CHECK）
  SEQUENCE_KEY        document_sequences.sequence_key（enums.SequenceKey）
  POLICY_TYPE         policy_definitions.policy_code（enums.PolicyType）
  ALLOCATION_TYPE     order_profit_allocations.allocation_type（**无 CHECK、表为空 → 纯字典 editable=True**）
  REPORT_NAME         报表页 Tab key（纯前端；value 对应报表组件，只允许改文案）

⚠️ ENTITY_TYPE 重置（8 → 30 值）
0009 种的是 `enums.EntityType` 的 8 个小写值，只覆盖活字段域。但审计流水
（`audit_logs.entity_type`）实际有 30 种取值（含 order_event / quality_issue / pool_account /
OrderTypeDef 等），审计面板拿这 8 值做筛选下拉会漏掉 22 种。用户裁决：**不拆词典，合并成一个**，
故本迁移把 ENTITY_TYPE 的 options 整体替换为「审计实测 30 种 + 原 8 值」的并集（按流水量降序）。
代价：活字段面板的实体下拉会多出它不支持的选项，已在 description 里注明前 8 项为可用实体。
downgrade 会还原为 0009 的 8 值。

label 严格对齐前端既有展示文案（labels.ts / format.ts / 各面板硬编码），保证接入后界面文案零变化。
`AUDIT_ACTION` 的 84 项里 `ORDER_LINK_DELETE`、`ORDER_FORM_FIELD_CHANGE` 前端 labels.ts 尚未收录，
本迁移补齐中文名。

本迁移只改数据、不改表结构；幂等：已存在相同 code 则跳过。

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-10-26 16:20:00.000000

"""

from __future__ import annotations

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet

revision: str = 'c9d0e1f2a3b4'
down_revision: str | None = 'b8c9d0e1f2a3'
branch_labels: str | None = None
depends_on: str | None = None

# code -> (label, group, editable, description, options)
SEED: dict[str, tuple[str, str, bool, str, list[dict[str, str]]]] = {
    "AUDIT_ACTION": (
        "审计动作",
        "AUDIT",
        False,
        "audit_logs.action（enums.AuditAction 84 项受控动作）。改动追溯页与审计面板的动作筛选来源",
        [
        {"value": "POOL_CREATE", "label": "新建资金池"},
        {"value": "POOL_UPDATE", "label": "编辑资金池"},
        {"value": "POOL_DISABLE", "label": "停用资金池"},
        {"value": "POOL_DELETE", "label": "删除资金池"},
        {"value": "ORDER_TYPE_CREATE", "label": "新建业务类型"},
        {"value": "ORDER_TYPE_UPDATE", "label": "编辑业务类型"},
        {"value": "ORDER_TYPE_DISABLE", "label": "停用业务类型"},
        {"value": "GAME_TYPE_CREATE", "label": "新建游戏类型"},
        {"value": "GAME_TYPE_UPDATE", "label": "编辑游戏类型"},
        {"value": "GAME_TYPE_DISABLE", "label": "停用游戏类型"},
        {"value": "GAME_TYPE_DEFAULT", "label": "设置默认游戏类型"},
        {"value": "ROUTE_UPDATE", "label": "更新资金路由"},
        {"value": "CUSTOMER_CREATE", "label": "新建客户"},
        {"value": "CUSTOMER_UPDATE", "label": "编辑客户"},
        {"value": "CONTACT_READ", "label": "查看联系人"},
        {"value": "CONTACT_WRITE", "label": "维护联系人"},
        {"value": "CUSTOMER_MERGE", "label": "合并客户"},
        {"value": "LEAD_CREATE", "label": "新建需求"},
        {"value": "LEAD_UPDATE", "label": "编辑需求"},
        {"value": "LEAD_CONVERT", "label": "需求转化"},
        {"value": "LEAD_CLOSE", "label": "关闭需求"},
        {"value": "ACCOUNT_CREATE", "label": "新建账号"},
        {"value": "ACCOUNT_UPDATE", "label": "编辑账号"},
        {"value": "ORDER_CREATE", "label": "新建订单"},
        {"value": "ORDER_UPDATE", "label": "编辑订单"},
        {"value": "ORDER_CANCEL", "label": "取消订单"},
        {"value": "ORDER_LINK_CREATE", "label": "新建订单关联"},
        {"value": "ORDER_LINK_DELETE", "label": "删除订单关联"},
        {"value": "EVENT_CREATE", "label": "登记订单事件"},
        {"value": "EVENT_POST", "label": "过账订单事件"},
        {"value": "DEPOSIT_CREATE", "label": "登记押金占用"},
        {"value": "DEPOSIT_RELEASE", "label": "释放押金"},
        {"value": "DEPOSIT_LOSS", "label": "登记押金损失"},
        {"value": "INSTALLMENT_CREATE", "label": "新建分期合约"},
        {"value": "INSTALLMENT_CANCEL", "label": "取消分期合约"},
        {"value": "INSTALLMENT_PAYMENT", "label": "分期收款"},
        {"value": "INSTALLMENT_EARLY_SETTLE", "label": "提前结清"},
        {"value": "INSTALLMENT_OVERDUE", "label": "标记逾期"},
        {"value": "INSTALLMENT_DEFAULT", "label": "登记违约"},
        {"value": "INSTALLMENT_WAIVE", "label": "期次减免"},
        {"value": "INSTALLMENT_EXTEND", "label": "期次展期"},
        {"value": "INSTALLMENT_RECOVER", "label": "回收账号"},
        {"value": "INSTALLMENT_RESELL", "label": "回收转售"},
        {"value": "DELIVER_CREATE", "label": "登记交付"},
        {"value": "REBATE_CREATE", "label": "登记返点"},
        {"value": "REBATE_SETTLE", "label": "返点结算"},
        {"value": "REBATE_REVERSE", "label": "冲销返点"},
        {"value": "RECONCILIATION_CREATE", "label": "登记对账"},
        {"value": "RECONCILIATION_RESOLVE", "label": "处置对账差异"},
        {"value": "PERIOD_LOCK", "label": "锁定账期"},
        {"value": "QUALITY_ISSUE_CREATE", "label": "新建质量工单"},
        {"value": "QUALITY_ISSUE_UPDATE", "label": "更新质量工单"},
        {"value": "QUALITY_ISSUE_CLOSE", "label": "关闭质量工单"},
        {"value": "CASHFLOW_CREATE", "label": "登记资金流水"},
        {"value": "CASHFLOW_APPROVE", "label": "审核通过流水"},
        {"value": "CASHFLOW_REJECT", "label": "驳回流水"},
        {"value": "CASHFLOW_REVERSE", "label": "冲销流水"},
        {"value": "TRANSFER_CREATE", "label": "发起资金划转"},
        {"value": "TRANSFER_REPAIR", "label": "修复单边划转"},
        {"value": "USER_CREATE", "label": "新建用户"},
        {"value": "USER_UPDATE", "label": "编辑用户"},
        {"value": "USER_DEACTIVATE", "label": "停用用户"},
        {"value": "USER_HANDOVER", "label": "交接用户权限"},
        {"value": "PASSWORD_CHANGE", "label": "修改密码"},
        {"value": "PASSWORD_RESET", "label": "重置密码"},
        {"value": "TEAM_CREATE", "label": "新建团队"},
        {"value": "TEAM_UPDATE", "label": "编辑团队"},
        {"value": "FIELD_DEFINITION_CHANGE", "label": "变更活字段定义"},
        {"value": "ORDER_FORM_FIELD_CHANGE", "label": "变更订单表单字段"},
        {"value": "POLICY_CHANGE", "label": "变更经营规则"},
        {"value": "EXCEPTION_APPROVE", "label": "审批异常"},
        {"value": "REPORT_EXPORT", "label": "导出报表"},
        {"value": "ATTACHMENT_UPLOAD", "label": "上传附件"},
        {"value": "ATTACHMENT_DELETE", "label": "删除附件"},
        {"value": "IMPORT_LAND", "label": "导入落库"},
        {"value": "IMPORT_COMMIT", "label": "确认导入批次"},
        {"value": "IMPORT_MAP", "label": "映射导入行"},
        {"value": "IMPORT_SKIP", "label": "跳过导入行"},
        {"value": "IMPORT_MARK_UNLINKED", "label": "标记单边划转"},
        {"value": "IMPORT_ROLLBACK", "label": "回滚导入批次"},
        {"value": "OPTION_SET_CREATE", "label": "新建选项词典"},
        {"value": "OPTION_SET_UPDATE", "label": "编辑选项词典"},
        {"value": "OPTION_SET_DELETE", "label": "删除选项词典"},
        {"value": "IMPORT_CORRECTION", "label": "更正导入批次"},
    ],
    ),
    "ORDER_EVENT_TYPE": (
        "订单事件类型",
        "ORDER",
        False,
        "order_events.event_type（CHECK 约束 + enums.EventType）。过账后的资金事件种类",
        [
        {"value": "BUY", "label": "买号"},
        {"value": "COST", "label": "附加成本"},
        {"value": "SELL", "label": "售出"},
        {"value": "PAYMENT", "label": "回款（分期）"},
        {"value": "DELIVER", "label": "交付"},
        {"value": "CANCEL", "label": "冲销"},
        {"value": "REFUND", "label": "退款"},
    ],
    ),
    "CASHFLOW_NATURE": (
        "资金流向",
        "FUND",
        False,
        "cashflow.nature（CHECK 约束 + enums.Nature）。与外部/本方/内部三向资金归集口径",
        [
        {"value": "EXTERNAL_IN", "label": "外部流入"},
        {"value": "BUSINESS_IN", "label": "本方流入"},
        {"value": "BUSINESS_OUT", "label": "本方流出"},
        {"value": "INTERNAL", "label": "内部调拨"},
    ],
    ),
    "DELIVERY_MODE": (
        "交付方式",
        "ORDER",
        False,
        "order_events.delivery_mode / installments.delivery_mode（CHECK 约束 + enums.DeliveryMode）",
        [
        {"value": "PLATFORM_OPERATOR", "label": "平台/本方操作换绑"},
        {"value": "CUSTOMER_SELF", "label": "客户自行换绑"},
    ],
    ),
    "REBATE_TYPE": (
        "返点类型",
        "FUND",
        False,
        "rebate_records.rebate_type（CHECK 约束 + enums.RebateType）。买号返点对应回收单、卖号返点对应售出单",
        [
        {"value": "BUY", "label": "买号返点（对应回收）"},
        {"value": "SELL", "label": "卖号返点（对应售出）"},
    ],
    ),
    "POOL_ACCOUNT_TYPE": (
        "资金池账户类型",
        "FUND",
        False,
        "pool_accounts.account_type（CHECK 约束：BANK/CASH/THIRD_PARTY）",
        [
        {"value": "BANK", "label": "银行账户"},
        {"value": "CASH", "label": "现金"},
        {"value": "THIRD_PARTY", "label": "第三方渠道"},
    ],
    ),
    "SEQUENCE_KEY": (
        "编号域",
        "SYSTEM",
        False,
        "document_sequences.sequence_key（enums.SequenceKey）。每个域独立发号，编号序列页只读展示",
        [
        {"value": "ORDER_HS", "label": "回收订单"},
        {"value": "ORDER_TH", "label": "提号订单"},
        {"value": "ORDER_DG", "label": "代挂订单"},
        {"value": "ORDER_DFQ", "label": "代分期订单"},
        {"value": "CUSTOMER", "label": "客户"},
        {"value": "COUNTERPARTY", "label": "合作方"},
        {"value": "LEAD", "label": "需求"},
        {"value": "QUALITY_ISSUE", "label": "质量工单"},
        {"value": "NOTIFICATION", "label": "通知"},
        {"value": "CASHFLOW", "label": "资金流水"},
        {"value": "IMPORT", "label": "导入批次"},
        {"value": "ATTACHMENT", "label": "附件"},
    ],
    ),
    "POLICY_TYPE": (
        "规则编码",
        "POLICY",
        False,
        "policy_definitions.policy_code（enums.PolicyType）。决定规则引擎走哪条分支，值不可增删；label 带编码前缀是为了与规则清单现有展示一致",
        [
        {"value": "REBATE", "label": "REBATE 返点"},
        {"value": "COMMISSION", "label": "COMMISSION 提成"},
        {"value": "INSTALLMENT", "label": "INSTALLMENT 分期"},
        {"value": "WRITE_DOWN", "label": "WRITE_DOWN 跌价"},
        {"value": "REFUND", "label": "REFUND 退款"},
        {"value": "DG_MIXED", "label": "DG_MIXED DG 混合单默认策略"},
    ],
    ),
    "ALLOCATION_TYPE": (
        "归属动作",
        "ORDER",
        True ,
        "order_profit_allocations.allocation_type。后端无 CHECK、表中当前无数据，属纯字典；对应利润分配的四个归属槽位",
        [
        {"value": "BUY", "label": "买号"},
        {"value": "SELL", "label": "售出"},
        {"value": "OPERATION", "label": "运营"},
        {"value": "COMPANY", "label": "公司归属"},
    ],
    ),
    "REPORT_NAME": (
        "报表名称",
        "REPORT",
        False,
        "报表页 Tab 的报表 key。value 与报表组件一一对应，新增无效项会渲染空白页，故只放开文案",
        [
        {"value": "inventory-health", "label": "库存健康"},
        {"value": "monthly-pnl", "label": "月度损益"},
        {"value": "commission", "label": "提成对账"},
        {"value": "daily-funds", "label": "资金日报"},
        {"value": "business-pnl", "label": "业务损益"},
        {"value": "finance-dimensions", "label": "资金属性"},
        {"value": "order-profit", "label": "订单利润"},
    ],
    ),
}

# ENTITY_TYPE 整体重置：code -> (新 options, 原 options)
RESEED: dict[str, tuple[list[dict[str, str]], list[dict[str, str]]]] = {
    "ENTITY_TYPE": (
        [
        {"value": "order", "label": "订单"},
        {"value": "order_event", "label": "订单事件"},
        {"value": "installment", "label": "分期合约"},
        {"value": "customer", "label": "客户"},
        {"value": "account", "label": "账号"},
        {"value": "cashflow", "label": "资金流水"},
        {"value": "user", "label": "用户"},
        {"value": "attachment", "label": "附件"},
        {"value": "reconciliation", "label": "日对账"},
        {"value": "quality_issue", "label": "质量工单"},
        {"value": "pool_account", "label": "资金池账户"},
        {"value": "lead", "label": "客户需求"},
        {"value": "order_form_field", "label": "订单表单字段"},
        {"value": "OrderTypePool", "label": "资金路由"},
        {"value": "transfer", "label": "资金划转"},
        {"value": "report_export", "label": "报表导出"},
        {"value": "policy_version", "label": "规则版本"},
        {"value": "import_batch", "label": "导入批次"},
        {"value": "rebate_settlement", "label": "返点结算"},
        {"value": "rebate_record", "label": "返点记录"},
        {"value": "OrderTypeDef", "label": "业务类型"},
        {"value": "counterparty", "label": "合作方"},
        {"value": "policy_definition", "label": "规则定义"},
        {"value": "option_set", "label": "选项词典"},
        {"value": "GameTypeOption", "label": "游戏类型"},
        {"value": "Pool", "label": "资金池"},
        {"value": "field_definition", "label": "活字段定义"},
        {"value": "Seed", "label": "种子数据"},
        {"value": "deposit", "label": "押金"},
        {"value": "pool", "label": "资金池"},
    ],
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
        for code, (new_options, _old) in RESEED.items():
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
        for code, (_new, old_options) in RESEED.items():
            row = session.scalars(select(OptionSet).where(OptionSet.code == code)).first()
            if row is not None:
                row.options = old_options
        session.commit()
    finally:
        session.close()
