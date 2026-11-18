import { api } from "./client";
import type { ProfitAllocationList } from "./types/profitAllocation";

/** 订单利润分润配置接口：只保存利润归属配置，不创建资金流水。 */
export const profitAllocationApi = {
  allocations: (orderId: number) =>
    api.get<ProfitAllocationList>(`/orders/${orderId}/profit-allocations`).then((r) => r.data),
  convert: (orderId: number, direction: "RATE_TO_AMOUNT" | "AMOUNT_TO_RATE", value: string) =>
    api.post<{ value: string | null }>(`/orders/${orderId}/profit-allocations/convert`, { direction, value }).then((r) => r.data),
  set: (orderId: number, items: { employee_ids?: number[]; user_id?: number | null; role: string; allocation_type?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | "" | null; allocation_rate?: string | null; allocation_amount?: string | null }[], formExtra?: Record<string, unknown>) =>
    api.put<ProfitAllocationList>(`/orders/${orderId}/profit-allocations`, { items, form_extra: formExtra }).then((r) => r.data),
};
