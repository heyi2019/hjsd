import { api, type CacheAwareRequestConfig } from "./client";
import type { AuditLogRow } from "./types/ops";
import type { BusinessPnlReport, CommissionReport, DataCenterSummary, MonthlyPnlReport, OrderProfitReport } from "./types/reporting";

type ReportPeriodParams = { from?: string; to?: string };
type ReportPageParams = { limit?: number; offset?: number; sort_desc?: boolean };
export type ReportExportParams = ReportPeriodParams & { mine?: boolean; all_people?: boolean; user_id?: number; sort_desc?: boolean };

function getFreshReport<T>(url: string, params?: ReportPeriodParams): Promise<T> {
  // 报表走共享 GET 缓存（SWR）：写操作会 clearApiCache，切回页面时缓存必已失效；
  // 切 Tab 因此不再强制回源阻塞。函数名保留 getFreshReport 以免触碰所有调用点。
  return api.get<T>(url, { params }).then((response) => response.data);
}

export const reportsApi = {
  exportCsv: (name: string, params?: ReportExportParams) => {
    const config: CacheAwareRequestConfig = { params, responseType: "blob", bypassCache: true };
    return api.get<Blob>(`/reports/${name}/export.csv`, config).then((response) => response.data);
  },
  monthlyPnl: (params?: { from?: string; to?: string }) =>
    getFreshReport<MonthlyPnlReport>("/reports/monthly-pnl", params),
  commission: (params?: ReportPeriodParams & ReportPageParams & { mine?: boolean; all_people?: boolean; user_id?: number; notification_id?: number }) =>
    getFreshReport<CommissionReport>("/reports/commission", params),
  businessPnl: (params?: { from?: string; to?: string }) =>
    getFreshReport<BusinessPnlReport>("/reports/business-pnl", params),
  dataCenter: (params?: { from?: string; to?: string }) =>
    getFreshReport<DataCenterSummary>("/reports/data-center", params),
  orderProfit: (params?: ReportPeriodParams & ReportPageParams) =>
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
};


