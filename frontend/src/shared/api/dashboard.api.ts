import { api } from "./client";

export interface DashboardAlert {
  type: "inventory_aging" | "pending_profit" | "allocated_profit" | "overdue_installment";
  message: string;
}

export interface DashboardSummary {
  period: { from: string; to: string } | null;
  orders: { total_count: number } | null;
  personal_orders: number | null;
  personal_customers: number | null;
  personal_earnings: string | null;
  inventory: { account_count: number; aging_count: number; overdue_count: number } | null;
  installments: { total_count: number; overdue_count: number } | null;
  alerts: DashboardAlert[];
}

export const dashboardApi = {
  summary: (period: { from: string; to: string } | null) => api.get<DashboardSummary>("/dashboard/summary", { params: period === null ? { all_time: true } : period }).then((response) => response.data),
};
