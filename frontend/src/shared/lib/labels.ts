/**
 * 面向用户的业务枚举文案。
 * 编码仍作为接口值和检索键保留，但页面正文统一显示中文；未知值保留原值，避免新主数据被静默吞掉。
 */
export const ORDER_TYPE_LABEL: Record<string, string> = {
  HS: "回收",
  TH: "提号",
  DG: "代挂",
  DFQ: "代分期",
};

export const CAPITAL_TYPE_LABEL: Record<string, string> = {
  STOCK: "库存型",
  ZERO: "零本金型",
  CREDIT: "分期业务",
};

export const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
};

export const BUSINESS_TYPE_LABEL: Record<string, string> = {
  RECOVERY: "回收",
  PICKUP: "提号",
  CONSIGNMENT: "代挂",
  INSTALLMENT: "代分期",
};

export const VALUE_ADDED_SERVICE_LABEL: Record<string, string> = {
  STOCK_SALE: "分期",
  ADVANCE_PURCHASE: "代分期",
  PICKUP_SALE: "提号分期",
  CONSIGNMENT_SALE: "代挂分期",
};

export const POOL_TYPE_LABEL: Record<string, string> = {
  INVEST: "投资款",
  PROFIT: "利润",
  OTHER: "其他",
};

export const POOL_OWNERSHIP_LABEL: Record<string, string> = {
  OWNED: "自有",
  CUSTODY: "代管",
  THIRD_PART: "第三方",
};

export const LINK_STATUS_LABEL: Record<string, string> = {
  LINKED: "已关联",
  UNLINKED: "未关联",
  ORPHAN: "孤儿单",
  UNLINKED_TRANSFER: "单边划转未关联",
};

export const COUNTERPARTY_TYPE_LABEL: Record<string, string> = {
  PEER: "同行",
  SUPPLIER: "供货方",
  PLATFORM: "平台",
};

export const USER_ROLE_LABEL: Record<string, string> = {
  ADMIN: "系统管理员",
  OPERATOR: "业务经办人",
  FINANCE: "财务",
  AUDITOR: "审核人",
  VIEWER: "查看人",
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
  pool: "资金池",
  cashflow: "资金流水",
  lead: "需求",
  counterparty: "合作方",
};

export const FIELD_TYPE_LABEL: Record<string, string> = {
  TEXT: "文本",
  NUMBER: "数字",
  DATE: "日期",
  BOOLEAN: "是/否",
  SELECT: "单选",
  MULTI_SELECT: "多选",
};

export function labelOf(value: string | null | undefined, labels: Record<string, string>): string {
  if (!value) return "-";
  return labels[value] ?? value;
}

export function orderTypeLabel(code: string | null | undefined, names?: Record<string, string>): string {
  if (!code) return "-";
  return names?.[code] ?? ORDER_TYPE_LABEL[code] ?? code;
}

/** 资金流向（Nature 四值）：与 backend/app/domain/enums.py Nature 一致。 */
export const NATURE_LABEL: Record<string, string> = {
  EXTERNAL_IN: "外部流入",
  BUSINESS_IN: "本方流入",
  BUSINESS_OUT: "本方流出",
  INTERNAL: "内部调拨",
};

/** 资金所有权性质（FundNature 三值）：与 backend/app/domain/enums.py FundNature 一致。 */
export const FUND_NATURE_LABEL: Record<string, string> = {
  BUSINESS: "本方经营",
  EXTERNAL: "外部/受托",
  INTERNAL: "内部调拨",
};

/** 核算属性（AccountingAttribute 13 值）：与 backend/app/domain/enums.py AccountingAttribute 一致。 */
export const ACCOUNTING_ATTRIBUTE_LABEL: Record<string, string> = {
  SELF_REVENUE: "自营收入",
  SELF_DIRECT_COST: "自营直接成本",
  TH_DIRECT_COST: "提号/代挂直接成本",
  TH_REVENUE: "提号/代挂收入",
  DFQ_PRINCIPAL: "代分期借款本金",
  SERVICE_REVENUE: "增值服务收入",
  REBATE_INCOME: "返点收入",
  OPERATING_EXPENSE: "运营费用",
  DEPOSIT: "押金/保证金",
  EXTERNAL_FUNDING: "外部资金",
  INTERNAL_TRANSFER: "内部调拨",
  REVERSAL: "冲销",
  REFUND: "退款",
};

/** 日对账快照状态（ReconciliationStatus）：OPEN=差异待处理（未核销）、RESOLVED=差异已处理（已核销）。
 *  注意 OPEN/RESOLVED 与质量域共用，不能改 StatusTag 全局映射，只能在对账调用点显式传 label。 */
export const RECONCILIATION_STATUS_LABEL: Record<string, string> = {
  OPEN: "未核销",
  RESOLVED: "已核销",
};

/** 审计动作中文名：与 backend/app/domain/enums.py AuditAction 全量对齐（79 项）。 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  POOL_CREATE: "新建资金池",
  POOL_UPDATE: "编辑资金池",
  POOL_DISABLE: "停用资金池",
  POOL_DELETE: "删除资金池",
  ORDER_TYPE_CREATE: "新建业务类型",
  ORDER_TYPE_UPDATE: "编辑业务类型",
  ORDER_TYPE_DISABLE: "停用业务类型",
  GAME_TYPE_CREATE: "新建游戏类型",
  GAME_TYPE_UPDATE: "编辑游戏类型",
  GAME_TYPE_DISABLE: "停用游戏类型",
  GAME_TYPE_DEFAULT: "设置默认游戏类型",
  ROUTE_UPDATE: "更新资金路由",
  CUSTOMER_CREATE: "新建客户",
  CUSTOMER_UPDATE: "编辑客户",
  CONTACT_READ: "查看联系人",
  CONTACT_WRITE: "维护联系人",
  CUSTOMER_MERGE: "合并客户",
  LEAD_CREATE: "新建需求",
  LEAD_UPDATE: "编辑需求",
  LEAD_CONVERT: "需求转化",
  LEAD_CLOSE: "关闭需求",
  ACCOUNT_CREATE: "新建账号",
  ACCOUNT_UPDATE: "编辑账号",
  ORDER_CREATE: "新建订单",
  ORDER_UPDATE: "编辑订单",
  ORDER_CANCEL: "取消订单",
  ORDER_LINK_CREATE: "新建订单关联",
  EVENT_CREATE: "登记订单事件",
  EVENT_POST: "过账订单事件",
  DEPOSIT_CREATE: "登记押金占用",
  DEPOSIT_RELEASE: "释放押金",
  DEPOSIT_LOSS: "登记押金损失",
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
  REBATE_SETTLE: "返点结算",
  REBATE_REVERSE: "冲销返点",
  RECONCILIATION_CREATE: "登记对账",
  RECONCILIATION_RESOLVE: "处置对账差异",
  PERIOD_LOCK: "锁定账期",
  QUALITY_ISSUE_CREATE: "新建质量工单",
  QUALITY_ISSUE_UPDATE: "更新质量工单",
  QUALITY_ISSUE_CLOSE: "关闭质量工单",
  CASHFLOW_CREATE: "登记资金流水",
  CASHFLOW_APPROVE: "审核通过流水",
  CASHFLOW_REJECT: "驳回流水",
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
  FIELD_DEFINITION_CHANGE: "变更活字段定义",
  POLICY_CHANGE: "变更经营规则",
  PROFIT_ALLOCATION_SET: "设置利润分润",
  EXCEPTION_APPROVE: "审批异常",
  REPORT_EXPORT: "导出报表",
  ATTACHMENT_UPLOAD: "上传附件",
  ATTACHMENT_DELETE: "删除附件",
  IMPORT_LAND: "导入落库",
  IMPORT_COMMIT: "确认导入批次",
  IMPORT_MAP: "映射导入行",
  IMPORT_SKIP: "跳过导入行",
  IMPORT_MARK_UNLINKED: "标记单边划转",
  IMPORT_ROLLBACK: "回滚导入批次",
  IMPORT_CORRECTION: "更正导入批次",
  OPTION_SET_CREATE: "新建选项词典",
  OPTION_SET_UPDATE: "编辑选项词典",
  OPTION_SET_DELETE: "删除选项词典",
};
