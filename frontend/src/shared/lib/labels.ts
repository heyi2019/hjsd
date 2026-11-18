/**
 * 面向用户的业务枚举文案。
 * 编码仍作为接口值和检索键保留，但页面正文统一显示中文；未知值保留原值，避免新主数据被静默吞掉。
 */
export const ORDER_TYPE_LABEL: Record<string, string> = {
  HS: "回收",
  TH: "提号",
  DG: "代挂",
};

export const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
};

export const BUSINESS_TYPE_LABEL: Record<string, string> = {
  RECOVERY: "回收",
  PICKUP: "提号",
  CONSIGNMENT: "代挂",
};

export const INVENTORY_STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "在库",
  OUT_OF_STOCK: "出库",
  SOLD: "已售",
  VOID: "下架",
};

/**
 * 增值服务只有「分期出售」一种业务名称，不按货源类型拆成「回收分期/提号分期/代挂分期」。
 * 能否分期由货源类型决定（回收、提号可选分期出售；代挂只做全款），而不是业务类别。
 */
export const VALUE_ADDED_SERVICE_LABEL: Record<string, string> = {
  STOCK_SALE: "分期出售",
  PICKUP_SALE: "分期出售",
  CONSIGNMENT_SALE: "分期出售",
};

export const POOL_TYPE_LABEL: Record<string, string> = {
  INVEST: "投资款",
  PROFIT: "利润",
  OTHER: "其他",
};

export const FUND_FLOW_SOURCE_LABEL: Record<string, string> = {
  MANUAL: "手工登记",
  ORDER: "订单",
  ORDER_EVENT: "订单事件",
  INSTALLMENT: "分期收款",
  REBATE: "返点",
  DEPOSIT: "押金",
  TRANSFER: "资金划转",
  REVERSAL: "冲销",
};

export const USER_ROLE_LABEL: Record<string, string> = {
  ADMIN: "系统管理员",
  OPERATOR: "业务经办人",
  FINANCE: "财务",
  AUDITOR: "审核人",
  VIEWER: "查看人",
};

/** 用户中心展示用权限名称：权限编码只保留在鉴权和接口层，不直接展示给用户。 */
export const PERMISSION_LABEL: Record<string, string> = {
  "customer.read": "查看客户",
  "customer.create": "新建客户",
  "customer.update": "编辑客户",
  "customer.contact.write": "维护客户联系人",
  "customer.merge": "合并客户",
  "counterparty.read": "查看合作方",
  "counterparty.manage": "管理合作方",
  "order.create": "新建订单",
  "order.update": "编辑订单",
  "order.event.post": "登记订单事件",
  "finance.read": "查看资金",
  "deposit.post": "登记押金",
  "finance.transfer": "资金划转",
  "finance.order.event.post": "过账订单资金事件",
  "policy.manage": "管理分润配置",
  "field-definition.manage": "管理字段配置",
  "audit.read": "查看审计记录",
  "pool.manage": "管理资金账户",
  "order-type.manage": "管理业务类型",
  "option-set.manage": "管理选项词典",
  "report.read": "查看报表",
  "report.export": "导出报表",
  "user.manage": "管理用户",
};

export const OWNER_SCOPE_LABEL: Record<string, string> = {
  SELF: "本人",
  TEAM: "团队",
  ALL: "全部",
};

export const ENTITY_TYPE_LABEL: Record<string, string> = {
  order: "订单",
  account: "账号",
  customer: "客户",
  installment: "分期合约",
  pool: "资金账户",
  cashflow: "资金流水",
  lead: "需求",
  counterparty: "合作方",
  // 订单详情页内编辑动作使用的细分实体类型（写点在 order_detail/editing/*）
  inventory_order_edit: "订单编辑",
  inventory_event_edit: "订单事件编辑",
  inventory_cashflow_edit: "流水编辑",
};

export const FIELD_TYPE_LABEL: Record<string, string> = {
  TEXT: "文本",
  NUMBER: "数字",
  DATE: "日期",
  BOOLEAN: "是/否",
  SELECT: "单选",
  MULTI_SELECT: "多选",
};

export function orderTypeLabel(code: string | null | undefined, names?: Record<string, string>): string {
  if (!code) return "-";
  return names?.[code] ?? ORDER_TYPE_LABEL[code] ?? code;
}

/** 核算属性：与 backend/app/domain/enums.py AccountingAttribute 一致。
 *  2026-11-18 口径改版：自营→回收、附加收入/支出概念废弃、返点/代挂收入独立。
 *  分组顺序：直接成本 → 收入 → 其他收支 → 工作室运营 → 押金 → 资金修正。 */
export const ACCOUNTING_ATTRIBUTE_LABEL: Record<string, string> = {
  SELF_DIRECT_COST: "回收成本",
  SELF_REVENUE: "回收收入",
  TH_DIRECT_COST: "提号成本",
  TH_REVENUE: "提号收入",
  DG_REVENUE: "代挂收入",
  SERVICE_REVENUE: "增值服务费收入",
  REBATE_INCOME: "返点收入",
  OTHER_INCOME: "其他收入",
  OTHER_EXPENSE: "其他支出",
  OPERATING_EXPENSE: "工作室运营支出",
  DEPOSIT: "押金/保证金",
  EXTERNAL_FUNDING: "外部资金",
  INTERNAL_TRANSFER: "内部调拨",
  REVERSAL: "冲销",
  REFUND: "退款",
};

/** 日对账快照状态（ReconciliationStatus）：OPEN=差异待处理（未核销）、RESOLVED=差异已处理（已核销）。
 *  注意 OPEN/RESOLVED 与对账域共用，不能改 StatusTag 全局映射，只能在对账调用点显式传 label。 */
export const RECONCILIATION_STATUS_LABEL: Record<string, string> = {
  OPEN: "未核销",
  RESOLVED: "已核销",
};

/** 资金流水系统类别中文：仅覆盖后端写路径写死的固定值（events.py EVENT_FLOW_MAP、
 *  deposits/rebates/cashflows 固定 category）；手工流水的类别是用户自填文本，不在表内原样显示。 */
export const CASHFLOW_CATEGORY_LABEL: Record<string, string> = {
  BUY: "买入",
  SELL: "售出",
  CANCEL: "取消退款",
  REBATE: "返点",
  DEPOSIT_HOLD: "押金占用",
  DEPOSIT_RELEASE: "押金退回",
  DEPOSIT_CANCEL: "押金取消",
  INSTALLMENT_PAYMENT: "分期还款",
  TRANSFER: "划转",
  REVERSAL: "冲销",
  OTHER: "其他",
};

/** 工作室运营账簿的科目词典 code（可配置 option set，设置页可增删支出科目）。 */
export const STUDIO_EXPENSE_ITEM_SET = "STUDIO_EXPENSE_ITEM";

/** 工作室收入科目（固定两项）：与支出科目词典分开维护。
 *  「退款」已随订单售后退款专用链路下线（退款统一并入普通支出）：收入科目不再保留退款。 */
export const STUDIO_INCOME_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "货款", label: "货款" },
  { value: "其他", label: "其他" },
];

/** 审计动作中文名：与 backend/app/domain/enums.py AuditAction 对齐（随枚举增补）。
 *  后端 option_sets 的 AUDIT_ACTION 为只读死字典，未覆盖的新动作由本表兜底翻译。 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  POOL_CREATE: "新建资金账户",
  POOL_UPDATE: "编辑资金账户",
  POOL_DISABLE: "停用资金账户",
  POOL_DELETE: "删除资金账户",
  ORDER_TYPE_CREATE: "新建业务类型",
  ORDER_TYPE_UPDATE: "编辑业务类型",
  ORDER_TYPE_DISABLE: "停用业务类型",
  GAME_TYPE_CREATE: "新建游戏类型",
  GAME_TYPE_UPDATE: "编辑游戏类型",
  GAME_TYPE_DISABLE: "停用游戏类型",
  GAME_TYPE_DEFAULT: "设置默认游戏类型",
  LIST_COLUMNS_UPDATE: "列表列显示配置变更",
  LIST_COLUMNS_RESET: "列表列配置恢复默认",
  LIST_COLUMN_ADD: "列表新增自定义列",
  LIST_COLUMN_REMOVE: "列表删除自定义列",
  CUSTOMER_CREATE: "新建客户",
  CUSTOMER_UPDATE: "编辑客户",
  CONTACT_WRITE: "维护联系人",
  CUSTOMER_MERGE: "合并客户",
  LEAD_CREATE: "新建需求",
  LEAD_UPDATE: "编辑需求",
  LEAD_CONVERT: "需求转化",
  LEAD_CLOSE: "关闭需求",
  ACCOUNT_CREATE: "新建账号",
  ACCOUNT_UPDATE: "编辑账号",
  ACCOUNT_DELETE: "删除",
  ORDER_DELETE: "删除",
  ORDER_CREATE: "新建订单",
  ORDER_UPDATE: "编辑订单",
  ORDER_CANCEL: "取消",
  LIST_EXPORT: "导出列表",
  EVENT_CREATE: "登记订单事件",
  EVENT_POST: "过账订单事件",
  DEPOSIT_CREATE: "登记押金占用",
  DEPOSIT_UPDATE: "编辑押金占用",
  DEPOSIT_DELETE: "删除押金占用",
  DEPOSIT_RELEASE: "释放押金",
  DEPOSIT_LOSS: "登记押金损失",
  DEPOSIT_CANCEL: "取消押金",
  INSTALLMENT_CREATE: "新建分期合约",
  INSTALLMENT_CANCEL: "取消分期合约",
  INSTALLMENT_PAYMENT: "分期收款",
  INSTALLMENT_EARLY_SETTLE: "提前结清",
  INSTALLMENT_OVERDUE: "标记逾期",
  INSTALLMENT_DEFAULT: "登记违约",
  INSTALLMENT_WAIVE: "期次减免",
  INSTALLMENT_EXTEND: "期次展期",
  INSTALLMENT_RECOVER: "回收账号",
  INSTALLMENT_RESELL: "回收转售",
  DELIVER_CREATE: "登记交付",
  REBATE_CREATE: "登记返点",
  REBATE_UPDATE: "编辑返点",
  REBATE_DELETE: "删除返点",
  REBATE_SETTLE: "返点结算",
  REBATE_REVERSE: "冲销返点",
  REBATE_VOID: "取消返点",
  RECONCILIATION_CREATE: "登记对账",
  RECONCILIATION_RESOLVE: "处置对账差异",
  CASHFLOW_CREATE: "登记资金流水",
  CASHFLOW_REVERSE: "冲销流水",
  TRANSFER_CREATE: "发起资金划转",
  TRANSFER_REPAIR: "修复单边划转",
  USER_CREATE: "新建用户",
  USER_UPDATE: "编辑用户",
  USER_DEACTIVATE: "停用用户",
  USER_HANDOVER: "交接用户权限",
  PASSWORD_CHANGE: "修改密码",
  PASSWORD_RESET: "重置密码",
  TEAM_CREATE: "新建团队",
  TEAM_UPDATE: "编辑团队",
  FIELD_DEFINITION_CHANGE: "变更表单字段配置",
  ORDER_FORM_FIELD_CHANGE: "变更订单表单字段",
  POLICY_CHANGE: "变更经营规则",
  PROFIT_ALLOCATION_SET: "设置利润分润",
  EXCEPTION_APPROVE: "审批异常",
  REPORT_EXPORT: "导出报表",
  ATTACHMENT_UPLOAD: "上传附件",
  ATTACHMENT_DELETE: "删除附件",
  OPTION_SET_CREATE: "新建选项词典",
  OPTION_SET_UPDATE: "编辑选项词典",
  OPTION_SET_DELETE: "删除选项词典",
};
