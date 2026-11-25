"""domain.enums：v1 封闭枚举与编号域。

取值以本模块定义为唯一来源，数据库 CHECK 约束与之同步：
- `portion`、业务 code 等核算枚举保持封闭；
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
class PoolStatus(StrEnum):
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


class PoolType(StrEnum):
    """业务用途分类（V31 注册表：新增类型仅登记，不改代码）。"""

    INVEST = "INVEST"
    PROFIT = "PROFIT"
    OTHER = "OTHER"


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
    CUSTOMER = "CUSTOMER"
    COUNTERPARTY = "COUNTERPARTY"
    LEAD = "LEAD"
    NOTIFICATION = "NOTIFICATION"
    # 资金流水按方向独立递增（用户口径 2026-10-28）：支出 ZC+五位流水、收入 SR+五位流水。
    CASHFLOW_OUT = "CASHFLOW_OUT"
    CASHFLOW_IN = "CASHFLOW_IN"
    # 库存编号：账号台账唯一编码，KU_ + 五位流水（KU_00001…），系统生成不可手改。
    STOCK_NO = "STOCK_NO"


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
    """表单扩展字段可挂载的业务实体域；只承载非核算辅助信息。"""

    ORDER = "order"
    ACCOUNT = "account"
    CUSTOMER = "customer"
    INSTALLMENT = "installment"
    POOL = "pool"
    CASHFLOW = "cashflow"
    LEAD = "lead"
    COUNTERPARTY = "counterparty"


# ---------------------------------------------------------------- 订单 / 事件
class OrderStatus(StrEnum):
    """订单生命周期：普通处理中、分期中、已完成或已取消。"""

    ACTIVE = "ACTIVE"
    INSTALLMENT = "INSTALLMENT"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class EventType(StrEnum):
    BUY = "BUY"
    SELL = "SELL"
    DELIVER = "DELIVER"
    CANCEL = "CANCEL"
    OPERATE = "OPERATE"
    REBATE = "REBATE"


class SaleMode(StrEnum):
    """售出业务属性：售出动作本身只有一个，结算方式由属性区分。"""

    FULL = "FULL"
    INSTALLMENT = "INSTALLMENT"


class OperationType(StrEnum):
    """运营动作属性：事件名统一为 OPERATE，具体动作由属性区分。"""

    IMAGE = "IMAGE"
    DESCRIPTION = "DESCRIPTION"
    CONSIGNMENT = "CONSIGNMENT"
    UNLIST = "UNLIST"


class CashflowLedgerType(StrEnum):
    """资金流水所属顶层账簿：公司业务或工作室运营。"""

    BUSINESS = "BUSINESS"
    STUDIO = "STUDIO"


class AccountingAttribute(StrEnum):
    """资金在经营核算中的具体归类。"""

    # 2026-11-18 口径改版：自营→回收、附加收入/附加支出概念废弃，
    # 返点收入(REBATE_INCOME)/代挂收入(DG_REVENUE)/其他收支(OTHER_*)独立成值。
    SELF_REVENUE = "SELF_REVENUE"  # 回收收入（HS 售出；工作室收入同用此属性）
    SELF_DIRECT_COST = "SELF_DIRECT_COST"  # 回收成本（HS 买入）
    TH_DIRECT_COST = "TH_DIRECT_COST"  # 提号成本（TH/DG 建单初始成本共用）
    TH_REVENUE = "TH_REVENUE"  # 提号收入
    DG_REVENUE = "DG_REVENUE"  # 代挂收入（DG 售出与分期收款）
    SERVICE_REVENUE = "SERVICE_REVENUE"  # 增值服务费收入
    REBATE_INCOME = "REBATE_INCOME"  # 返点收入（category=REBATE）
    OTHER_INCOME = "OTHER_INCOME"  # 其他收入（TIP/PENALTY 等非返点收入）
    OTHER_EXPENSE = "OTHER_EXPENSE"  # 其他支出
    OPERATING_EXPENSE = "OPERATING_EXPENSE"  # 工作室运营支出
    DEPOSIT = "DEPOSIT"  # 押金/保证金
    EXTERNAL_FUNDING = "EXTERNAL_FUNDING"  # 外部资金
    INTERNAL_TRANSFER = "INTERNAL_TRANSFER"  # 内部调拨
    REVERSAL = "REVERSAL"  # 冲销
    REFUND = "REFUND"  # 退款


class Direction(StrEnum):
    IN = "IN"
    OUT = "OUT"


class CashflowSourceType(StrEnum):
    """资金流水的统一业务来源。"""

    MANUAL = "MANUAL"
    ORDER = "ORDER"
    ORDER_EVENT = "ORDER_EVENT"
    INSTALLMENT = "INSTALLMENT"
    REBATE = "REBATE"
    DEPOSIT = "DEPOSIT"
    TRANSFER = "TRANSFER"
    REVERSAL = "REVERSAL"


class AccountStatus(StrEnum):
    """账号生命周期状态（ACC-01-03）：保留出库原因与可逆动作。"""

    WAITING = "WAITING"  # 待售
    SOLD = "SOLD"  # 已售
    VOID = "VOID"  # 取消/失效


class InventoryStatus(StrEnum):
    """库存归属状态：只表达账号是否仍在库存，不承载订单或分期进度。"""

    IN_STOCK = "IN_STOCK"
    OUT_OF_STOCK = "OUT_OF_STOCK"


class InventoryAgeLevel(StrEnum):
    """库存账号的库龄档位：7 天内正常、8–30 天预警、超过 30 天超期。

    阈值是经营口径而不是展示细节，故与库存状态同处领域枚举，前后端不得各写一份。
    """

    NORMAL = "NORMAL"
    WARNING = "WARNING"
    OVERDUE = "OVERDUE"


class WalletRealName(StrEnum):
    """库存账号的钱包实名状态：交付前需确认实名是否已解绑。"""

    NOT_CANCELLED = "N"
    CANCELLED = "Y"


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
    PICKUP_SALE = "PICKUP_SALE"
    CONSIGNMENT_SALE = "CONSIGNMENT_SALE"


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


class AllocationRole(StrEnum):
    """订单利润分配角色（BAS-06-03：固定结构化比例与人员角色）。"""

    OWNER = "OWNER"  # 主责
    BUYER = "BUYER"  # 采买
    SALES = "SALES"  # 销售
    SERVICE = "SERVICE"  # 服务


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
    GAME_TYPE_DELETE = "GAME_TYPE_DELETE"
    CUSTOMER_CREATE = "CUSTOMER_CREATE"
    CUSTOMER_UPDATE = "CUSTOMER_UPDATE"
    CONTACT_WRITE = "CONTACT_WRITE"
    CUSTOMER_MERGE = "CUSTOMER_MERGE"
    LEAD_CREATE = "LEAD_CREATE"
    LEAD_UPDATE = "LEAD_UPDATE"
    LEAD_CONVERT = "LEAD_CONVERT"
    LEAD_CLOSE = "LEAD_CLOSE"
    ACCOUNT_CREATE = "ACCOUNT_CREATE"
    ACCOUNT_UPDATE = "ACCOUNT_UPDATE"
    # 删除：物理清理库存及其关联订单从属数据，审计必须带删除原因与库存快照。
    ACCOUNT_DELETE = "ACCOUNT_DELETE"
    ORDER_CREATE = "ORDER_CREATE"
    ORDER_UPDATE = "ORDER_UPDATE"
    ORDER_DELETE = "ORDER_DELETE"
    ORDER_CANCEL = "ORDER_CANCEL"
    LIST_COLUMNS_UPDATE = "LIST_COLUMNS_UPDATE"  # 列表列显示/顺序配置变更
    LIST_COLUMNS_RESET = "LIST_COLUMNS_RESET"  # 列表列配置恢复默认（清空该列表全部配置行）
    LIST_COLUMN_ADD = "LIST_COLUMN_ADD"  # 列表新增自定义列（绑定表单自定义字段）
    LIST_COLUMN_REMOVE = "LIST_COLUMN_REMOVE"  # 列表删除自定义列
    LIST_EXPORT = "LIST_EXPORT"  # 业务主列表按列配置导出 CSV
    EVENT_CREATE = "EVENT_CREATE"
    EVENT_POST = "EVENT_POST"
    DEPOSIT_CREATE = "DEPOSIT_CREATE"
    DEPOSIT_UPDATE = "DEPOSIT_UPDATE"
    DEPOSIT_DELETE = "DEPOSIT_DELETE"
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
    REBATE_UPDATE = "REBATE_UPDATE"
    REBATE_DELETE = "REBATE_DELETE"
    # 分次结算模型层已下线（11-05）：以下三个动作不再写入，保留枚举值仅供
    # 历史 audit_logs 正确显示（前端 labels.ts 有对应中文标签）。
    REBATE_SETTLE = "REBATE_SETTLE"
    REBATE_REVERSE = "REBATE_REVERSE"
    REBATE_VOID = "REBATE_VOID"
    RECONCILIATION_CREATE = "RECONCILIATION_CREATE"
    RECONCILIATION_RESOLVE = "RECONCILIATION_RESOLVE"
    CASHFLOW_CREATE = "CASHFLOW_CREATE"
    CASHFLOW_UPDATE = "CASHFLOW_UPDATE"
    CASHFLOW_DELETE = "CASHFLOW_DELETE"
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
    OPTION_SET_CREATE = "OPTION_SET_CREATE"  # 新建选项词典
    OPTION_SET_UPDATE = "OPTION_SET_UPDATE"  # 编辑选项词典
    OPTION_SET_DELETE = "OPTION_SET_DELETE"  # 删除选项词典


__all__ = [
    "AccountStatus",
    "AuditAction",
    "AccountingAttribute",
    "CashflowLedgerType",
    "CashflowSourceType",
    "CounterpartyRole",
    "CounterpartyStatus",
    "CounterpartyType",
    "CustomerRole",
    "CustomerStatus",
    "DepositStatus",
    "Direction",
    "EntityType",
    "EventType",
    "SaleMode",
    "OperationType",
    "InstallmentContractType",
    "InstallmentDispositionAction",
    "InstallmentStatus",
    "InventoryAgeLevel",
    "LeadStatus",
    "LeadType",
    "OrderStatus",
    "PoolStatus",
    "PoolType",
    "Portion",
    "RebateType",
    "ReconciliationStatus",
    "ScheduleStatus",
    "SequenceKey",
    "StrEnum",
]
