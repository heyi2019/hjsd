import { api, type CacheAwareRequestConfig } from "./client";
import type { AuditEntityStat, AuditLogRow } from "./types/ops";
import type { BusinessPnlReport, CommissionReport, DataCenterSummary, MonthlyPnlReport, OrderProfitReport } from "./types/reporting";

type ReportPeriodParams = { from?: string; to?: string };
export type ReportExportParams = ReportPeriodParams & { mine?: boolean; all_people?: boolean; user_id?: number; sort_desc?: boolean };

function getFreshReport<T>(url: string, params?: ReportPeriodParams): Promise<T> {
  const config: CacheAwareRequestConfig = { params, refreshCache: true };
  return api.get<T>(url, config).then((response) => response.data);
}

export const reportsApi = {
  exportCsv: (name: string, params?: ReportExportParams) => {
    const config: CacheAwareRequestConfig = { params, responseType: "blob", bypassCache: true };
    return api.get<Blob>(`/reports/${name}/export.csv`, config).then((response) => response.data);
  },
  monthlyPnl: (params?: { from?: string; to?: string }) =>
    getFreshReport<MonthlyPnlReport>("/reports/monthly-pnl", params),
  commission: (params?: { from?: string; to?: string; mine?: boolean; all_people?: boolean; user_id?: number; notification_id?: number }) =>
    getFreshReport<CommissionReport>("/reports/commission", params),
  businessPnl: (params?: { from?: string; to?: string }) =>
    getFreshReport<BusinessPnlReport>("/reports/business-pnl", params),
  dataCenter: (params?: { from?: string; to?: string }) =>
    getFreshReport<DataCenterSummary>("/reports/data-center", params),
  orderProfit: (params?: { from?: string; to?: string }) =>
    getFreshReport<OrderProfitReport>("/reports/order-profit", params),
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


