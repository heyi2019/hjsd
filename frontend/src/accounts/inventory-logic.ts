import type { Account, AccountExecutionDetail } from "../shared/api/catalog";

export const STATUS_OPTIONS = [
  { value: "IN_STOCK", label: "在库" },
  { value: "INSTALLMENT", label: "分期中" },
  { value: "SOLD", label: "已售" },
  { value: "VOID", label: "下架" },
];

export const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
};

export const INVENTORY_TYPE_LABEL: Record<string, string> = {
  RECOVERY: "回收",
  PICKUP: "提号",
  CONSIGNMENT: "代挂",
};

export const BUSINESS_OPTIONS = Object.entries(BUSINESS_MODE_LABEL).map(([value, label]) => ({ value, label }));
export const INVENTORY_TYPE_OPTIONS = Object.entries(INVENTORY_TYPE_LABEL).map(([value, label]) => ({ value, label }));
export const PROFILE_ACCOUNT_TYPES = new Set(["RECOVERY", "CONSIGNMENT"]);
export const EDITABLE_ACCOUNT_TYPES = new Set(["RECOVERY", "PICKUP", "CONSIGNMENT"]);

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function inventoryStatusLabel(value: string): string {
  return STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function financeTypeLabel(eventType: string, direction: string): string {
  const labels: Record<string, string> = {
    BUY: "买号本金",
    COST: "账号成本",
    SELL: "售出回款",
    PAYMENT: "分期回款",
    CANCEL: "取消退款",
  };
  return labels[eventType] ?? (direction === "IN" ? "其他收入" : "其他支出");
}

export function accountFinancialFlows(detail: AccountExecutionDetail | undefined) {
  return detail?.orders.flatMap((order) => [
    ...order.events.flatMap((event) => event.cashflow ? [{ order, event, cashflow: event.cashflow }] : []),
    ...(order.cashflows ?? []).map((cashflow) => ({ order, event: null, cashflow })),
  ]) ?? [];
}

export function rebateTypeLabel(rebateType?: string | null, channel?: string | null): string {
  if (rebateType === "BUY") return "买号返点";
  if (rebateType === "SELL") return "卖号返点";
  if (channel === "买号返点") return "买号返点";
  if (channel === "卖号返点") return "卖号返点";
  return "其他返点";
}

export function inventoryAge(row: Pick<Account, "status" | "buy_date">, now = new Date()): {
  days: number;
  color: "green" | "orange" | "red";
} | null {
  if (!["IN_STOCK", "INSTALLMENT"].includes(row.status) || !row.buy_date) return null;
  const buyDate = new Date(`${row.buy_date}T00:00:00`);
  if (!Number.isFinite(buyDate.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(0, Math.floor((today.getTime() - buyDate.getTime()) / DAY_IN_MS));
  return { days, color: days <= 7 ? "green" : days <= 30 ? "orange" : "red" };
}
