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

/** 数据库保留到秒，业务页面统一展示到分钟。 */
export function formatDateTimeMinute(value: string | null | undefined): string {
  if (!value) return "-";
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}

/** 计算入库到出库的实际在手时长，按分钟展示。 */
export function formatElapsedTime(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return "-";
  const startAt = new Date(start).getTime();
  const endAt = new Date(end).getTime();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return "-";
  const totalMinutes = Math.floor((endAt - startAt) / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes || parts.length === 0) parts.push(`${minutes}分`);
  return parts.join("");
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "进行中",
  INSTALLMENT: "分期中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

export const INSTALLMENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "还款中",
  OVERDUE: "逾期",
  SETTLED: "已结清",
  DELIVERED: "已交付",
  DEFAULTED: "违约",
  CLOSED: "已关闭",
  CANCELLED: "已取消",
};

/** PENDING 是合约落库的内部初始化值，业务界面按还款中展示，不作为筛选项暴露。 */
export function installmentDisplayStatus(status: string): string {
  return status === "PENDING" ? "ACTIVE" : status;
}

export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  WAITING: "待售",
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
 */
const EXECUTION_ACTION_LABEL: Record<string, string> = {
  BUY: "买号",
  COST: "费用支出",
  SELL: "售出",
  PAYMENT: "回款（分期）",
  DELIVER: "交付",
  CANCEL: "取消",
  REFUND: "退款",
};

export function executionActionLabel(
  eventType: string | null | undefined,
  orderType?: string | null,
): string {
  if (!eventType) return "-";
  if (eventType === "DELIVER") return "买入交付";
  // 词典未加载时回落模块常量，保证零行为变化。
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
