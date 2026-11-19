import { api } from "./client";
import type { AuditEntityStat, AuditLogRow } from "./types/ops";
import type { BusinessPnlReport, CommissionReport, DataCenterSummary, MonthlyPnlReport, OrderProfitReport } from "./types/reporting";

export const reportsApi = {
  exportCsv: (name: string, params?: {from?: string; to?: string; mine?: boolean; all_people?: boolean; user_id?: number}) => api.get<Blob>(`/reports/${name}/export.csv`, {params, responseType: "blob"}).then(r => r.data),
  monthlyPnl: (params?: { from?: string; to?: string }) =>
    api.get<MonthlyPnlReport>("/reports/monthly-pnl", { params }).then((r) => r.data),
  commission: (params?: { from?: string; to?: string; mine?: boolean; all_people?: boolean; user_id?: number }) =>
    api.get<CommissionReport>("/reports/commission", { params }).then((r) => r.data),
  businessPnl: (params?: { from?: string; to?: string }) =>
    api.get<BusinessPnlReport>("/reports/business-pnl", { params }).then((r) => r.data),
  dataCenter: (params?: { from?: string; to?: string }) =>
    api.get<DataCenterSummary>("/reports/data-center", { params }).then((r) => r.data),
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
  /** 按 entity_type 汇总真实累计数。 */
  stats: (entityTypes: string[]) =>
    api
      .get<{ items: AuditEntityStat[] }>("/audit-logs/stats", {
        params: { entity_types: entityTypes.join(",") },
      })
      .then((r) => r.data.items),
};


