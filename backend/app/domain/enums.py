"""domain.enums：v1 封闭枚举与编号域。

取值以《ERP_数据字典_v1.0.md》为准：
- `capital_type`、`ownership`、业务 code 等核算枚举保持封闭；
- `pool_type` 是**注册表**（V31），扩展登记新值即可，不改表。
"""
from __future__ import annotations

from enum import Enum


class StrEnum(str, Enum):
    """便于与 JSON / SQLAlchemy String 比较的字符串枚举。"""

    def __str__(self) -> str:  # pragma: no cover - 简单转发
        return str(self.value)

    @classmethod
    def values(cls) -> tuple[str, ...]:
        return tuple(item.value for item in cls)


# ---------------------------------------------------------------- 资金 / 主数据
class PoolOwnership(StrEnum):
    """资金归属：决定是否计入权益（PRD §1.2、V30）。"""

    OWNED = "OWNED"  # 自有，计入权益
    CUSTODY = "CUSTODY"  # 代管，只计现金头寸
    THIRD_PART = "THIRD_PART"  # 第三方，只计现金头寸


class PoolStatus(StrEnum):
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


class PoolType(StrEnum):
    """业务用途分类（V31 注册表：新增类型仅登记，不改代码）。"""

    INVEST = "INVEST"
    PROFIT = "PROFIT"
    OTHER = "OTHER"


class CapitalType(StrEnum):
    """资金性质：默认取业务定义，允许按单覆盖（V34）。"""

    STOCK = "STOCK"  # 回收：库存型
    ZERO = "ZERO"  # 代挂：零本金
    CREDIT = "CREDIT"  # 历史资金分类编码


class Portion(StrEnum):
    """资金份额主语：路由按此区分本金 / 利润 / 总额。"""

    PRINCIPAL = "PRINCIPAL"
    PROFIT = "PROFIT"
    GROSS = "GROSS"


# ---------------------------------------------------------------- 编号 / 序列
class SequenceKey(StrEnum):
    """document_sequences 的编号域。

    主业务按类型独立递增（BAS-02-04）；客户 CUS、合作方 CP 各自独立（V19/V20 不可复用）。
    """

    ORDER_HS = "ORDER_HS"
    ORDER_TH = "ORDER_TH"
    ORDER_DG = "ORDER_DG"
    ORDER_DFQ = "ORDER_DFQ"
    # 分期订单独立编号域（自营分期，关联回收/提号/代挂来源订单）；
    # 分期合约号统一「订单号-INS序号」衍生：自营 FQ0001-INS01 / 代分期 DFQ0001-INS01。
    INSTALLMENT = "INSTALLMENT"
    CUSTOMER = "CUSTOMER"
    COUNTERPARTY = "COUNTERPARTY"
    LEAD = "LEAD"
    QUALITY_ISSUE = "QUALITY_ISSUE"
    NOTIFICATION = "NOTIFICATION"
    # 资金流水按方向独立递增（用户口径 2026-10-28）：支出 ZC+五位流水、收入 SR+五位流水。
    CASHFLOW_OUT = "CASHFLOW_OUT"
    CASHFLOW_IN = "CASHFLOW_IN"
    IMPORT = "IMPORT"
    ATTACHMENT = "ATTACHMENT"


class LinkStatus(StrEnum):
    """关联状态：禁止 AUTO_MATCHED（V22）。"""

    LINKED = "LINKED"
    UNLINKED = "UNLINKED"
    ORPHAN = "ORPHAN"
    UNLINKED_TRANSFER = "UNLINKED_TRANSFER"


# ---------------------------------------------------------------- 客户 / 合作方
class CustomerStatus(StrEnum):
    """客户状态：停用与已合并均不可作为新订单参与方（CUS-01）。"""

    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"
    MERGED = "MERGED"


class LeadType(StrEnum):
    """客户需求池类型（CUS-02）。"""

    FIND_ACCOUNT = "FIND_ACCOUNT"
    SELL_ACCOUNT = "SELL_ACCOUNT"
    SPECIFIC_SEARCH = "SPECIFIC_SEARCH"


class LeadStatus(StrEnum):
    OPEN = "OPEN"
    CONVERTED = "CONVERTED"
    CLOSED = "CLOSED"


class QualityIssueStatus(StrEnum):
    OPEN = "OPEN"
    IN_PROGRESS = "IN_PROGRESS"
    CLOSED = "CLOSED"


class CounterpartyStatus(StrEnum):
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


class CounterpartyType(StrEnum):
    """同行 / 供货方 / 平台：与客户严格分离（BAS-02-05）。"""

    PEER = "PEER"
    SUPPLIER = "SUPPLIER"
    PLATFORM = "PLATFORM"


class CustomerRole(StrEnum):
    """订单客户角色（CUS-01-04）：同行/供货方不得写入客户角色。"""

    SELLER = "SELLER"
    BUYER = "BUYER"
    CONSIGNOR = "CONSIGNOR"
    INSTALLMENT_CUSTOMER = "INSTALLMENT_CUSTOMER"


class CounterpartyRole(StrEnum):
    PEER = "PEER"
    SUPPLIER = "SUPPLIER"
    PLATFORM = "PLATFORM"


class EntityType(StrEnum):
    """活字段可挂载的业务实体域；只承载非核算辅助信息。"""

    ORDER = "order"
    ACCOUNT = "account"
    CUSTOMER = "customer"
    INSTALLMENT = "installment"
    POOL = "pool"
    CASHFLOW = "cashflow"
    LEAD = "lead"
    COUNTERPARTY = "counterparty"


class FieldType(StrEnum):
    """活字段支持的值类型；前后端与数据库共用同一封闭集合。"""

    TEXT = "TEXT"
    NUMBER = "NUMBER"
    DATE = "DATE"
    BOOLEAN = "BOOLEAN"
    SELECT = "SELECT"
    MULTI_SELECT = "MULTI_SELECT"


# ---------------------------------------------------------------- 订单 / 事件
class OrderStatus(StrEnum):
    """订单状态机（错误码文档 §2）：创建即 ACTIVE，无草稿态（2026-10-13 移除）。"""

    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class OrderLinkType(StrEnum):
    """订单关联方向：当前订单的来源单或后续单。"""

    SOURCE = "SOURCE"
    FOLLOW_UP = "FOLLOW_UP"


class EventType(StrEnum):
    BUY = "BUY"
    COST = "COST"
    SELL = "SELL"
    PAYMENT = "PAYMENT"
    DELIVER = "DELIVER"
    CANCEL = "CANCEL"
    REFUND = "REFUND"


class Nature(StrEnum):
    EXTERNAL_IN = "EXTERNAL_IN"
    BUSINESS_IN = "BUSINESS_IN"
    BUSINESS_OUT = "BUSINESS_OUT"
    INTERNAL = "INTERNAL"


class FundNature(StrEnum):
    """资金所有权性质：本方经营、外部/受托或本方内部调拨。"""

    BUSINESS = "BUSINESS"
    EXTERNAL = "EXTERNAL"
    INTERNAL = "INTERNAL"


class AccountingAttribute(StrEnum):
    """资金在经营核算中的具体归类。"""

    SELF_REVENUE = "SELF_REVENUE"
    SELF_DIRECT_COST = "SELF_DIRECT_COST"
    TH_DIRECT_COST = "TH_DIRECT_COST"
    TH_REVENUE = "TH_REVENUE"
    DFQ_PRINCIPAL = "DFQ_PRINCIPAL"
    SERVICE_REVENUE = "SERVICE_REVENUE"
    REBATE_INCOME = "REBATE_INCOME"
    OPERATING_EXPENSE = "OPERATING_EXPENSE"
    DEPOSIT = "DEPOSIT"
    EXTERNAL_FUNDING = "EXTERNAL_FUNDING"
    INTERNAL_TRANSFER = "INTERNAL_TRANSFER"
    REVERSAL = "REVERSAL"
    REFUND = "REFUND"


class Direction(StrEnum):
    IN = "IN"
    OUT = "OUT"


class CashflowStatus(StrEnum):
    """独立资金流水审核状态；业务事件派生流水直接为 APPROVED。"""

    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class AccountStatus(StrEnum):
    """账号状态（ACC-01-03）：只由订单事件驱动。"""

    IN_STOCK = "IN_STOCK"  # 在库
    INSTALLMENT = "INSTALLMENT"  # 分期中
    SOLD = "SOLD"  # 已售
    VOID = "VOID"  # 取消/失效


class BusinessMode(StrEnum):
    """库存账号所属业务模式。"""

    SELF = "SELF"
    DISTRIBUTION = "DISTRIBUTION"


class InventoryType(StrEnum):
    """库存账号的业务来源类型。"""

    RECOVERY = "RECOVERY"
    PICKUP = "PICKUP"
    CONSIGNMENT = "CONSIGNMENT"


class InstallmentContractType(StrEnum):
    """各业务独立分期合约类型，避免把不同资金/资产口径混在一起。"""

    STOCK_SALE = "STOCK_SALE"
    ADVANCE_PURCHASE = "ADVANCE_PURCHASE"
    PICKUP_SALE = "PICKUP_SALE"
    CONSIGNMENT_SALE = "CONSIGNMENT_SALE"


class DeliveryMode(StrEnum):
    PLATFORM_OPERATOR = "PLATFORM_OPERATOR"
    CUSTOMER_SELF = "CUSTOMER_SELF"


class CommissionMode(StrEnum):
    DEDUCT_FROM_SETTLEMENT = "DEDUCT_FROM_SETTLEMENT"
    SEPARATE_PAYMENT = "SEPARATE_PAYMENT"


class CommissionPayer(StrEnum):
    BUYER = "BUYER"
    CONSIGNOR = "CONSIGNOR"
    PLATFORM = "PLATFORM"


class InstallmentStatus(StrEnum):
    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    OVERDUE = "OVERDUE"
    SETTLED = "SETTLED"
    DELIVERED = "DELIVERED"
    DEFAULTED = "DEFAULTED"
    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"


class ScheduleStatus(StrEnum):
    PENDING = "PENDING"
    PARTIAL = "PARTIAL"
    PAID = "PAID"
    OVERDUE = "OVERDUE"
    WAIVED = "WAIVED"


class InstallmentDispositionAction(StrEnum):
    RECOVER = "RECOVER"
    RESELL = "RESELL"


class DepositStatus(StrEnum):
    PAID = "PAID"
    PARTIALLY_RETURNED = "PARTIALLY_RETURNED"
    RETURNED = "RETURNED"
    LOST = "LOST"
    CANCELLED = "CANCELLED"


class PolicyStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    SUPERSEDED = "SUPERSEDED"  # 已被新版本取代（BAS-06-02：已引用版本不可改，只能新建）


class PolicyScopeType(StrEnum):
    """规则适用范围（BAS-06-01：可按规则、范围、版本、生效期管理）。"""

    GLOBAL = "GLOBAL"  # 全局
    ORDER_TYPE = "ORDER_TYPE"  # 按业务类型（scope_id = order_type_defs.id）
    USER = "USER"  # 按人员（scope_id = users.id）
    POOL = "POOL"  # 按资金池（scope_id = pools.id）


class PolicyType(StrEnum):
    """可配置经营参数（BAS-06-01 列举的六类）。"""

    REBATE = "REBATE"  # 返点
    COMMISSION = "COMMISSION"  # 提成
    INSTALLMENT = "INSTALLMENT"  # 分期
    WRITE_DOWN = "WRITE_DOWN"  # 跌价
    REFUND = "REFUND"  # 退款
    DG_MIXED = "DG_MIXED"  # DG 混合单默认策略


class AllocationRole(StrEnum):
    """订单利润分配角色（BAS-06-03：固定结构化比例与人员角色）。"""

    OWNER = "OWNER"  # 主责
    BUYER = "BUYER"  # 采买
    SALES = "SALES"  # 销售
    SERVICE = "SERVICE"  # 服务


class ImportBatchStatus(StrEnum):
    """标准导入批次：导入只落「原始行 + 映射」，绝不自动匹配（MIG-01）。"""

    DRAFT = "DRAFT"
    MAPPED = "MAPPED"
    COMMITTED = "COMMITTED"
    REJECTED = "REJECTED"
    ROLLED_BACK = "ROLLED_BACK"  # 整批逻辑回滚（MIG-01-07），原始文件与日志保留
    CORRECTED = "CORRECTED"  # 已确认批次的冲销/更正（MIG-01-08），不删原始记录


class ImportSourceKind(StrEnum):
    """标准导入来源类型；不再接受 LEGACY_* 或任意自定义值。"""

    ORDER = "STANDARD_ORDER"
    ACCOUNT = "STANDARD_ACCOUNT"
    CASHFLOW = "STANDARD_CASHFLOW"
    INSTALLMENT = "STANDARD_INSTALLMENT"
    LEAD = "STANDARD_LEAD"


class ImportRowStatus(StrEnum):
    PENDING = "PENDING"
    MAPPED = "MAPPED"
    UNMAPPED = "UNMAPPED"
    IMPORTED = "IMPORTED"
    SKIPPED = "SKIPPED"
    ROLLED_BACK = "ROLLED_BACK"  # 随批次回滚（MIG-01-07）


class RebateStatus(StrEnum):
    OPEN = "OPEN"
    PARTIALLY_SETTLED = "PARTIALLY_SETTLED"
    SETTLED = "SETTLED"
    VOID = "VOID"


class RebateType(StrEnum):
    """返点归属方向：买入侧和售出侧可挂在同一主订单上。"""

    BUY = "BUY"
    SELL = "SELL"


class ReconciliationStatus(StrEnum):
    """日对账快照状态：差异处理完成后才可核销。"""

    OPEN = "OPEN"
    RESOLVED = "RESOLVED"


class AuditAction(StrEnum):
    """受控动作清单（BAS-05-03）：这些动作必须写审计日志。"""

    POOL_CREATE = "POOL_CREATE"
    POOL_UPDATE = "POOL_UPDATE"
    POOL_DISABLE = "POOL_DISABLE"
    POOL_DELETE = "POOL_DELETE"
    ORDER_TYPE_CREATE = "ORDER_TYPE_CREATE"
    ORDER_TYPE_UPDATE = "ORDER_TYPE_UPDATE"
    ORDER_TYPE_DISABLE = "ORDER_TYPE_DISABLE"
    GAME_TYPE_CREATE = "GAME_TYPE_CREATE"
    GAME_TYPE_UPDATE = "GAME_TYPE_UPDATE"
    GAME_TYPE_DISABLE = "GAME_TYPE_DISABLE"
    GAME_TYPE_DEFAULT = "GAME_TYPE_DEFAULT"
    ROUTE_UPDATE = "ROUTE_UPDATE"
    CUSTOMER_CREATE = "CUSTOMER_CREATE"
    CUSTOMER_UPDATE = "CUSTOMER_UPDATE"
    CONTACT_READ = "CONTACT_READ"
    CONTACT_WRITE = "CONTACT_WRITE"
    CUSTOMER_MERGE = "CUSTOMER_MERGE"
    LEAD_CREATE = "LEAD_CREATE"
    LEAD_UPDATE = "LEAD_UPDATE"
    LEAD_CONVERT = "LEAD_CONVERT"
    LEAD_CLOSE = "LEAD_CLOSE"
    ACCOUNT_CREATE = "ACCOUNT_CREATE"
    ACCOUNT_UPDATE = "ACCOUNT_UPDATE"
    ORDER_CREATE = "ORDER_CREATE"
    ORDER_UPDATE = "ORDER_UPDATE"
    ORDER_CANCEL = "ORDER_CANCEL"
    ORDER_LINK_CREATE = "ORDER_LINK_CREATE"
    ORDER_LINK_DELETE = "ORDER_LINK_DELETE"
    EVENT_CREATE = "EVENT_CREATE"
    EVENT_POST = "EVENT_POST"
    DEPOSIT_CREATE = "DEPOSIT_CREATE"
    DEPOSIT_RELEASE = "DEPOSIT_RELEASE"
    DEPOSIT_LOSS = "DEPOSIT_LOSS"
    DEPOSIT_CANCEL = "DEPOSIT_CANCEL"  # 未发生任何退还/损失的押金取消（全额冲正流水）
    INSTALLMENT_CREATE = "INSTALLMENT_CREATE"
    INSTALLMENT_CANCEL = "INSTALLMENT_CANCEL"
    INSTALLMENT_PAYMENT = "INSTALLMENT_PAYMENT"
    INSTALLMENT_EARLY_SETTLE = "INSTALLMENT_EARLY_SETTLE"
    INSTALLMENT_OVERDUE = "INSTALLMENT_OVERDUE"
    INSTALLMENT_DEFAULT = "INSTALLMENT_DEFAULT"
    INSTALLMENT_WAIVE = "INSTALLMENT_WAIVE"
    INSTALLMENT_EXTEND = "INSTALLMENT_EXTEND"
    INSTALLMENT_RECOVER = "INSTALLMENT_RECOVER"
    INSTALLMENT_RESELL = "INSTALLMENT_RESELL"
    DELIVER_CREATE = "DELIVER_CREATE"
    REBATE_CREATE = "REBATE_CREATE"
    REBATE_SETTLE = "REBATE_SETTLE"
    REBATE_REVERSE = "REBATE_REVERSE"
    REBATE_VOID = "REBATE_VOID"  # 零结算返点记录作废（有结算走 REBATE_REVERSE）
    RECONCILIATION_CREATE = "RECONCILIATION_CREATE"
    RECONCILIATION_RESOLVE = "RECONCILIATION_RESOLVE"
    PERIOD_LOCK = "PERIOD_LOCK"
    QUALITY_ISSUE_CREATE = "QUALITY_ISSUE_CREATE"
    QUALITY_ISSUE_UPDATE = "QUALITY_ISSUE_UPDATE"
    QUALITY_ISSUE_CLOSE = "QUALITY_ISSUE_CLOSE"
    CASHFLOW_CREATE = "CASHFLOW_CREATE"
    CASHFLOW_APPROVE = "CASHFLOW_APPROVE"
    CASHFLOW_REJECT = "CASHFLOW_REJECT"
    CASHFLOW_REVERSE = "CASHFLOW_REVERSE"
    TRANSFER_CREATE = "TRANSFER_CREATE"
    TRANSFER_REPAIR = "TRANSFER_REPAIR"
    USER_CREATE = "USER_CREATE"
    USER_UPDATE = "USER_UPDATE"
    USER_DEACTIVATE = "USER_DEACTIVATE"
    USER_HANDOVER = "USER_HANDOVER"
    PASSWORD_CHANGE = "PASSWORD_CHANGE"
    PASSWORD_RESET = "PASSWORD_RESET"
    TEAM_CREATE = "TEAM_CREATE"
    TEAM_UPDATE = "TEAM_UPDATE"
    FIELD_DEFINITION_CHANGE = "FIELD_DEFINITION_CHANGE"
    ORDER_FORM_FIELD_CHANGE = "ORDER_FORM_FIELD_CHANGE"
    POLICY_CHANGE = "POLICY_CHANGE"
    # 分润单独成动作：此前与政策变更共用 EXCEPTION_APPROVE，审计页按「异常审批」
    # 筛选会把分润设置一起筛出来，语义失真。
    PROFIT_ALLOCATION_SET = "PROFIT_ALLOCATION_SET"  # 设置订单利润分润
    EXCEPTION_APPROVE = "EXCEPTION_APPROVE"
    REPORT_EXPORT = "REPORT_EXPORT"
    ATTACHMENT_UPLOAD = "ATTACHMENT_UPLOAD"
    ATTACHMENT_DELETE = "ATTACHMENT_DELETE"
    # 标准导入（MIG-01）：与 EXCEPTION_APPROVE 分开，避免「导入」被误读为「异常审批」。
    # audit_logs.action 无 CHECK 约束，新增枚举值不需要迁移。
    IMPORT_LAND = "IMPORT_LAND"  # 原始行落地（只存原文，不做字段推断）
    IMPORT_COMMIT = "IMPORT_COMMIT"  # 映射确认后生成业务实体
    IMPORT_REJECT = "IMPORT_REJECT"  # 未确认批次整批驳回（终态，不可再提交）
    IMPORT_MAP = "IMPORT_MAP"  # 人工指派某行的订单/账号映射
    IMPORT_SKIP = "IMPORT_SKIP"  # 人工跳过导入行并留存理由
    IMPORT_MARK_UNLINKED = "IMPORT_MARK_UNLINKED"  # 标记为未关联划转
    IMPORT_ROLLBACK = "IMPORT_ROLLBACK"  # 整批逻辑回滚（原始行与日志保留）
    OPTION_SET_CREATE = "OPTION_SET_CREATE"  # 新建选项词典
    OPTION_SET_UPDATE = "OPTION_SET_UPDATE"  # 编辑选项词典
    OPTION_SET_DELETE = "OPTION_SET_DELETE"  # 删除选项词典
    IMPORT_CORRECTION = "IMPORT_CORRECTION"  # 建冲销/更正批次


__all__ = [
    "AccountStatus",
    "AuditAction",
    "CapitalType",
    "AccountingAttribute",
    "CashflowStatus",
    "CounterpartyRole",
    "CounterpartyStatus",
    "CounterpartyType",
    "CustomerRole",
    "CustomerStatus",
    "DeliveryMode",
    "DepositStatus",
    "Direction",
    "EntityType",
    "ImportBatchStatus",
    "ImportRowStatus",
    "EventType",
    "FundNature",
    "InstallmentContractType",
    "InstallmentDispositionAction",
    "InstallmentStatus",
    "LinkStatus",
    "LeadStatus",
    "LeadType",
    "Nature",
    "OrderLinkType",
    "OrderStatus",
    "PolicyStatus",
    "PoolOwnership",
    "PoolStatus",
    "PoolType",
    "Portion",
    "QualityIssueStatus",
    "RebateStatus",
    "RebateType",
    "ReconciliationStatus",
    "ScheduleStatus",
    "SequenceKey",
    "StrEnum",
]
