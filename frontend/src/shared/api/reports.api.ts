import { api } from "./client";
import type { AuditLogRow, BusinessPnlReport, CommissionReport, DailyFundsReport, InventoryHealthReport, MonthlyPnlReport, OrderProfitReport } from "./types";

export const reportsApi = {
  exportCsv: (name: string, params?: {from?: string; to?: string}) => api.get<Blob>(`/reports/${name}/export.csv`, {params, responseType: "blob"}).then(r => r.data),
  inventoryHealth: () => api.get<InventoryHealthReport>("/reports/inventory-health").then((r) => r.data),
  monthlyPnl: (params?: { from?: string; to?: string }) =>
    api.get<MonthlyPnlReport>("/reports/monthly-pnl", { params }).then((r) => r.data),
  commission: (params?: { from?: string; to?: string; mine?: boolean; all_people?: boolean; user_id?: number }) =>
    api.get<CommissionReport>("/reports/commission", { params }).then((r) => r.data),
  businessPnl: (params?: { from?: string; to?: string }) =>
    api.get<BusinessPnlReport>("/reports/business-pnl", { params }).then((r) => r.data),
  dailyFunds: (params?: { on?: string }) =>
    api.get<DailyFundsReport>("/reports/daily-funds", { params }).then((r) => r.data),
  orderProfit: (params?: { from?: string; to?: string }) =>
    api.get<OrderProfitReport>("/reports/order-profit", { params }).then((r) => r.data),
};
export const auditApi = {
  list: (params?: {
    entity_type?: string;
    entity_id?: string;
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) =>
    api.get<{ items: AuditLogRow[]; total: number }>("/audit-logs", { params }).then((r) => r.data),
  actions: () => api.get<{ items: string[] }>("/audit-logs/actions").then((r) => r.data.items),
};
