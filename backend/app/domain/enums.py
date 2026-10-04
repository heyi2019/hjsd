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
    PASS_THRU = "PASS_THRU"  # 提号：过账型
    ZERO = "ZERO"  # 代挂：零本金
    CREDIT = "CREDIT"  # 代分期：垫资型


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
    CUSTOMER = "CUSTOMER"
    COUNTERPARTY = "COUNTERPARTY"
    ACCOUNT = "ACCOUNT"
    INSTALLMENT = "INSTALLMENT"
    EVENT = "EVENT"
    CASHFLOW = "CASHFLOW"
    REBATE = "REBATE"
    DEPOSIT = "DEPOSIT"
    ISSUE = "ISSUE"
    IMPORT = "IMPORT"


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
    """活字段实体域。"""

    CUSTOMER = "customer"
    ACCOUNT = "account"
    ORDER = "order"


# ---------------------------------------------------------------- 订单 / 事件
class OrderStatus(StrEnum):
    """订单状态机（错误码文档 §2）。"""

    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class EventType(StrEnum):
    BUY = "BUY"
    COST = "COST"
    SELL = "SELL"
    PAYMENT = "PAYMENT"
    DELIVER = "DELIVER"
    TRANSFER = "TRANSFER"
    CANCEL = "CANCEL"


class Nature(StrEnum):
    EXTERNAL_IN = "EXTERNAL_IN"
    BUSINESS_IN = "BUSINESS_IN"
    BUSINESS_OUT = "BUSINESS_OUT"
    INTERNAL = "INTERNAL"


class Direction(StrEnum):
    IN = "IN"
    OUT = "OUT"


class AccountStatus(StrEnum):
    """账号状态（ACC-01-03）：只由订单事件驱动。"""

    PENDING = "PENDING"  # 待收
    IN_STOCK = "IN_STOCK"  # 在库
    INSTALLMENT = "INSTALLMENT"  # 分期中
    FOR_SALE = "FOR_SALE"  # 待售
    SOLD = "SOLD"  # 已售
    VOID = "VOID"  # 取消/失效


class InstallmentContractType(StrEnum):
    """STOCK_SALE 仅已买入 HS；ADVANCE_PURCHASE 仅 DFQ，两者不可混用。"""

    STOCK_SALE = "STOCK_SALE"
    ADVANCE_PURCHASE = "ADVANCE_PURCHASE"


class DeliveryMode(StrEnum):
    PLATFORM_OPERATOR = "PLATFORM_OPERATOR"
    CUSTOMER_SELF = "CUSTOMER_SELF"


class InstallmentStatus(StrEnum):
    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    OVERDUE = "OVERDUE"
    SETTLED = "SETTLED"
    DELIVERED = "DELIVERED"
    DEFAULTED = "DEFAULTED"
    CANCELLED = "CANCELLED"


class ScheduleStatus(StrEnum):
    PENDING = "PENDING"
    PARTIAL = "PARTIAL"
    PAID = "PAID"
    OVERDUE = "OVERDUE"
    WAIVED = "WAIVED"


class DepositStatus(StrEnum):
    PAID = "PAID"
    PARTIALLY_RETURNED = "PARTIALLY_RETURNED"
    RETURNED = "RETURNED"
    CANCELLED = "CANCELLED"


class PolicyStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"


class IssueType(StrEnum):
    """异常类型（QLT-01-01）：八类可检测异常 + 历史导入保留。"""

    UNROUTED_EVENT = "UNROUTED_EVENT"  # 未路由事件
    SINGLE_SIDED_TRANSFER = "SINGLE_SIDED_TRANSFER"  # 单边划转
    NEGATIVE_AVAILABLE = "NEGATIVE_AVAILABLE"  # 负可用余额
    TH_UNCLOSED = "TH_UNCLOSED"  # TH 未闭环
    UNCOLLECTED_REBATE = "UNCOLLECTED_REBATE"  # 未归集返点
    OVERDUE_INSTALLMENT = "OVERDUE_INSTALLMENT"  # 分期逾期
    ACCOUNT_CONFLICT = "ACCOUNT_CONFLICT"  # 账号状态冲突
    ORPHAN_CASHFLOW = "ORPHAN_CASHFLOW"  # 孤儿流水
    HISTORY_UNMAPPED = "HISTORY_UNMAPPED"  # 历史行未映射（P2，不自动猜测）
    UNLINKED_TRANSFER = "UNLINKED_TRANSFER"  # 历史单边划转未裁决（MIG-01-06，仅标记不配对）


class IssueSeverity(StrEnum):
    BLOCKER = "BLOCKER"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class IssueStatus(StrEnum):
    OPEN = "OPEN"
    ASSIGNED = "ASSIGNED"
    RESOLVED = "RESOLVED"
    CLOSED = "CLOSED"
    IGNORED = "IGNORED"


class ImportBatchStatus(StrEnum):
    """P2 历史导入批次：导入只落「原始行 + 映射」，绝不自动匹配（MIG-01）。"""

    DRAFT = "DRAFT"
    MAPPED = "MAPPED"
    COMMITTED = "COMMITTED"
    REJECTED = "REJECTED"
    ROLLED_BACK = "ROLLED_BACK"  # 整批逻辑回滚（MIG-01-07），原始文件与日志保留
    CORRECTED = "CORRECTED"  # 已确认批次的冲销/更正（MIG-01-08），不删原始记录


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


class AuditAction(StrEnum):
    """受控动作清单（BAS-05-03）：这些动作必须写审计日志。"""

    POOL_CREATE = "POOL_CREATE"
    POOL_UPDATE = "POOL_UPDATE"
    POOL_DISABLE = "POOL_DISABLE"
    POOL_DELETE = "POOL_DELETE"
    ORDER_TYPE_CREATE = "ORDER_TYPE_CREATE"
    ORDER_TYPE_UPDATE = "ORDER_TYPE_UPDATE"
    ORDER_TYPE_DISABLE = "ORDER_TYPE_DISABLE"
    ROUTE_UPDATE = "ROUTE_UPDATE"
    CUSTOMER_CREATE = "CUSTOMER_CREATE"
    CUSTOMER_UPDATE = "CUSTOMER_UPDATE"
    CONTACT_READ = "CONTACT_READ"
    CONTACT_WRITE = "CONTACT_WRITE"
    CUSTOMER_MERGE = "CUSTOMER_MERGE"
    ORDER_CREATE = "ORDER_CREATE"
    ORDER_UPDATE = "ORDER_UPDATE"
    EVENT_CREATE = "EVENT_CREATE"
    EVENT_POST = "EVENT_POST"
    TRANSFER_CREATE = "TRANSFER_CREATE"
    DEPOSIT_CREATE = "DEPOSIT_CREATE"
    DEPOSIT_RELEASE = "DEPOSIT_RELEASE"
    INSTALLMENT_CREATE = "INSTALLMENT_CREATE"
    INSTALLMENT_PAYMENT = "INSTALLMENT_PAYMENT"
    DELIVER_CREATE = "DELIVER_CREATE"
    REBATE_CREATE = "REBATE_CREATE"
    REBATE_SETTLE = "REBATE_SETTLE"
    FIELD_DEFINITION_CHANGE = "FIELD_DEFINITION_CHANGE"
    POLICY_CHANGE = "POLICY_CHANGE"
    EXCEPTION_APPROVE = "EXCEPTION_APPROVE"


__all__ = [
    "AccountStatus",
    "AuditAction",
    "CapitalType",
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
    "InstallmentContractType",
    "InstallmentStatus",
    "IssueSeverity",
    "IssueStatus",
    "IssueType",
    "LinkStatus",
    "Nature",
    "OrderStatus",
    "PolicyStatus",
    "PoolOwnership",
    "PoolStatus",
    "PoolType",
    "Portion",
    "RebateStatus",
    "ScheduleStatus",
    "SequenceKey",
    "StrEnum",
]
