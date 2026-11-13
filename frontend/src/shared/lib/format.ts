/** 金额与日期展示：后端以字符串传金额（DECIMAL），前端不做浮点运算。 */

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
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
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
  WAITING: "在库",
  SOLD: "已售",
  VOID: "失效",
};

const EXECUTION_ACTION_LABEL: Record<string, string> = {
  DELIVER: "交付",
  CANCEL: "取消",
  OPERATE: "运营",
  REBATE: "返点",
};

const INVENTORY_ENTRY_ACTION_LABEL: Record<string, string> = {
  HS: "回收入库",
  TH: "提号入库",
  DG: "代挂入库",
};

export function executionActionLabel(
  eventType: string | null | undefined,
  orderType?: string | null,
  deliveryDirection?: "BUY" | "SELL" | null,
): string {
  if (!eventType) return "-";
  if (eventType === "BUY") return INVENTORY_ENTRY_ACTION_LABEL[orderType ?? ""] ?? "账号入库";
  if (eventType === "SELL") return "账号售出";
  if (eventType === "DELIVER") {
    return deliveryDirection === "BUY" ? "买号交付" : "卖号交付";
  }
  return EXECUTION_ACTION_LABEL[eventType] ?? "运营";
}

/** 状态 → antd Tag 颜色；不使用颜色单独承载紧急程度。 */
export function statusColor(status: string): string {
  switch (status) {
    case "ACTIVE":
    case "PAID":
    case "SETTLED":
    case "IN_STOCK":
    case "WAITING":
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
    case "VOID":
      return "red";
    case "COMPLETED":
    case "DELIVERED":
    case "RETURNED":
      return "cyan";
    case "SOLD":
      return "red";
    default:
      return "default";
  }
}
