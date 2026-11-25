import { api, type CacheAwareRequestConfig } from "./client";

export interface WorkbenchSummary {
  period: { from: string; to: string } | null;
  orders: { total_count: number } | null;
  personal_orders: number | null;
  personal_customers: number | null;
  personal_earnings: string | null;
  inventory: { account_count: number; aging_count: number; overdue_count: number } | null;
  installments: { total_count: number; overdue_count: number } | null;
}

export const workbenchApi = {
  summary: (period?: { from: string; to: string } | null) => api.get<WorkbenchSummary>("/workbench/summary", { params: period === null ? { all_time: true } : period, refreshCache: true } as CacheAwareRequestConfig).then((response) => response.data),
};
