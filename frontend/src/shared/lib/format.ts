/** 金额与日期展示：后端以字符串传金额（DECIMAL），前端不做浮点运算。 */
import { configurableLabel } from "./optionSets";

export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  const num = Number(text);
  if (Number.isNaN(num)) return text;
  return num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function signedMoney(value: string | number | null | undefined): string {
  return money(value);
}

export function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "进行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

export const INSTALLMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "待首付",
  ACTIVE: "收款中",
  OVERDUE: "逾期",
  SETTLED: "已结清",
  DELIVERED: "已交付",
  DEFAULTED: "违约",
  CLOSED: "已关闭",
  CANCELLED: "已取消",
};

export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "在库",
  INSTALLMENT: "分期中",
  SOLD: "已售",
  VOID: "失效",
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  BUY: "买号",
  COST: "附加成本",
  SELL: "售出",
  PAYMENT: "回款（分期）",
  DELIVER: "交付",
  CANCEL: "冲销",
  REFUND: "退款",
};

/**
 * 执行动作统一文案：底层事件编码保持稳定，页面不再直接暴露 BUY/SELL/DELIVER。
 * 代分期的 BUY 仍是兼容性事件编码，页面只展示为“付款”；借款本金由业务字段和资金属性表达。
 * 买入交付和售出交付结合订单类型判断：代分期是向客户完成售出交付，其余交付语义归入买入交付。
 */
export const EXECUTION_ACTION_LABEL: Record<string, string> = {
  BUY: "买号",
  COST: "费用支出",
  SELL: "售出",
  PAYMENT: "回款（分期）",
  DELIVER: "交付",
  CANCEL: "取消",
  REFUND: "退款",
};

/** 跨业务复用的能力，不作为买卖资金事件落账。 */
export const COMMON_CAPABILITY_LABEL: Record<string, string> = {
  ACQUISITION: "获客",
};

export function executionActionLabel(
  eventType: string | null | undefined,
  orderType?: string | null,
): string {
  if (!eventType) return "-";
  if (eventType === "BUY" && orderType === "DFQ") return "付款";
  if (eventType === "PAYMENT" && orderType === "DFQ") return "还款（分期）";
  if (eventType === "DELIVER") return orderType === "DFQ" ? "售出交付" : "买入交付";
  // 词典未加载时回落模块常量，保证零行为变化；DFQ 的上下文特判仍在前面优先命中。
  return configurableLabel("ORDER_EVENT_TYPE", eventType, EXECUTION_ACTION_LABEL);
}

/** 状态 → antd Tag 颜色；不使用颜色单独承载紧急程度。 */
export function statusColor(status: string): string {
  switch (status) {
    case "ACTIVE":
    case "PAID":
    case "SETTLED":
    case "IN_STOCK":
      return "green";
    case "DRAFT":
    case "PENDING":
    case "PARTIALLY_RETURNED":
    case "PARTIALLY_SETTLED":
    case "INSTALLMENT":
      return "blue";
    case "OVERDUE":
    case "DEFAULTED":
    case "LOST":
    case "DISABLED":
      return "red";
    case "COMPLETED":
    case "DELIVERED":
    case "RETURNED":
      return "cyan";
    default:
      return "default";
  }
}
