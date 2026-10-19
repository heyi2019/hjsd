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
  STOCK_SALE: "分期出售",
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
  customer: "客户",
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
