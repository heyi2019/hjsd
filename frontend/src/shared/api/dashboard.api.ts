import { api } from "./client";

export interface DashboardSummary {
  period: { from: string; to: string };
  orders: { total_count: number; completed_count: number; active_count: number } | null;
  personal_orders: number | null;
  personal_customers: number | null;
  personal_earnings: string | number | null;
  inventory: { account_count: number; aging_count: number; overdue_count: number } | null;
  installments: { total_count: number; overdue_count: number } | null;
  notifications: { pending_profit_count: number; allocated_profit_count: number };
  reminders: {
    inventory_aging_days: number;
    profit_notifications_enabled: boolean;
    overdue_installments_enabled: boolean;
  };
}

export const dashboardApi = {
  summary: () => api.get<DashboardSummary>("/dashboard/summary").then((response) => response.data),
};
