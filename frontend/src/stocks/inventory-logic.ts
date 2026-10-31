import type { Account, AccountExecutionDetail } from "../shared/api/catalog";

/** 状态 / 业务 / 类型的展示文案（用于表格、导出、报表渲染）。
 * ⚠️ 这些是渲染用的静态文案；筛选项的「可选项是哪些」由设置页「选项词典」配置（INVENTORY_STATUS / INVENTORY_BUSINESS / INVENTORY_TYPE）。 */
export const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "在库",
  INSTALLMENT: "分期中",
  SOLD: "已售",
  VOID: "下架",
};

// 业务 / 类型 / 增值服务文案统一引用共享标签源（shared/lib/labels），避免多份副本漂移。
// VALUE_ADDED_SERVICE_LABEL 在此补齐 PICKUP_SALE/CONSIGNMENT_SALE，修复库存页与导出裸码显示。
export { BUSINESS_MODE_LABEL, VALUE_ADDED_SERVICE_LABEL } from "../shared/lib/labels";
export { BUSINESS_TYPE_LABEL as INVENTORY_TYPE_LABEL } from "../shared/lib/labels";

export const PROFILE_ACCOUNT_TYPES = new Set(["RECOVERY", "CONSIGNMENT"]);
export const EDITABLE_ACCOUNT_TYPES = new Set(["RECOVERY", "PICKUP", "CONSIGNMENT"]);

/** 可编辑/更多操作适用范围：三类业务类型，以及业务类型留空的代分期账号（DFQ 建单即入库，inventory_type 为空）。 */
export function isEditableAccountType(inventoryType?: string | null): boolean {
  return inventoryType == null || EDITABLE_ACCOUNT_TYPES.has(inventoryType);
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function inventoryStatusLabel(value: string): string {
  return STATUS_LABEL[value] ?? value;
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
