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

export const ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
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
  CANCELLED: "已取消",
};

export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  IN_STOCK: "在库",
  INSTALLMENT: "分期中",
  FOR_SALE: "待售",
  SOLD: "已售",
  VOID: "失效",
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  BUY: "买入/付同行",
  COST: "附加成本",
  SELL: "售出/收款",
  PAYMENT: "分期收款",
  DELIVER: "换绑交付",
  TRANSFER: "划转",
  CANCEL: "冲销",
};

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
