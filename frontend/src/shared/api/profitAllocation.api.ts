import { api, type CacheAwareRequestConfig } from "./client";
import type { ProfitAllocationList } from "./types/profitAllocation";

/** 订单利润分润配置接口：只保存利润归属配置，不创建资金流水。 */
export const profitAllocationApi = {
  companySettings: () => api.get<{ profit_rate: string; loss_rate: string }>("/profit-allocation/company-settings").then((r) => r.data),
  updateCompanySettings: (payload: { profit_rate: string; loss_rate: string }) =>
    api.put<{ profit_rate: string; loss_rate: string }>("/profit-allocation/company-settings", payload).then((r) => r.data),
  allocations: (orderId: number) =>
    api.get<ProfitAllocationList>(`/orders/${orderId}/profit-allocations`, { refreshCache: true } as CacheAwareRequestConfig).then((r) => r.data),
  set: (orderId: number, items: { employee_ids?: number[]; user_id?: number | null; role: string; allocation_type?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | "" | null; allocation_rate?: string | null; allocation_amount?: string | null }[], formExtra: Record<string, unknown> | undefined, amountsChanged: boolean, expectedOrderProfit: string, ratesChanged: boolean) =>
    api.put<ProfitAllocationList>(`/orders/${orderId}/profit-allocations`, { items, form_extra: formExtra, amounts_changed: amountsChanged, rates_changed: ratesChanged, expected_order_profit: expectedOrderProfit }).then((r) => r.data),
};
