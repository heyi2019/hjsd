import { api } from "./client";
import type { ImportBatch, ImportRow, MappingPreview, ReconciliationReport } from "./types/imports";
import type { AuditEntityStat, AuditLogRow } from "./types/ops";
import type { BusinessPnlReport, CommissionReport, DailyFundsReport, DataCenterSummary, MonthlyPnlReport, OrderProfitReport } from "./types/reporting";

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
  /** 按 entity_type 汇总真实累计数。
   *  ⚠️ 不要用 list 的 `total` 当累计数——它的语义是「当前页行数」，
   *  limit=1 时恒等于 1（见 backend/app/audit/router.py）。 */
  stats: (entityTypes: string[]) =>
    api
      .get<{ items: AuditEntityStat[] }>("/audit-logs/stats", {
        params: { entity_types: entityTypes.join(",") },
      })
      .then((r) => r.data.items),
};

export const importsApi = {
  batches: () => api.get<{ items: ImportBatch[]; total: number }>("/imports/batches").then((r) => r.data),
  createBatch: (payload: { source_name: string; rows: Record<string, unknown>[]; source_kind?: string; note?: string }) =>
    api.post<ImportBatch>("/imports/batches", payload).then((r) => r.data),
  rows: (batchId: number, status?: string) =>
    api.get<{ items: ImportRow[]; total: number }>(`/imports/batches/${batchId}/rows`, { params: { status } }).then((r) => r.data),
  preview: (batchId: number) =>
    api.get<MappingPreview>(`/imports/batches/${batchId}/preview`).then((r) => r.data),
  reconciliation: (batchId: number) =>
    api.get<ReconciliationReport>(`/imports/batches/${batchId}/reconciliation`).then((r) => r.data),
  /** basis 必填：补录关联必须有依据（MIG-01-05） */
  map: (rowId: number, payload: { order_id?: number | null; account_id?: number | null; basis: string }) =>
    api.post<ImportRow>(`/imports/rows/${rowId}/map`, payload).then((r) => r.data),
  skip: (rowId: number, reason: string) =>
    api.post<ImportRow>(`/imports/rows/${rowId}/skip`, { reason }).then((r) => r.data),
  /** 只打标记 + 开工单，服务端绝不补造配对流水 */
  markUnlinked: (rowId: number, note?: string) =>
    api.post<ImportRow>(`/imports/rows/${rowId}/unlinked-transfer`, { note }).then((r) => r.data),
  commit: (batchId: number) =>
    api.post<ImportBatch & { imported: number; unmapped: number }>(`/imports/batches/${batchId}/commit`).then((r) => r.data),
  rollback: (batchId: number, reason: string) =>
    api.post<ImportBatch>(`/imports/batches/${batchId}/rollback`, { reason }).then((r) => r.data),
  createCorrection: (batchId: number, payload: { rows: Record<string, unknown>[]; reason: string }) =>
    api.post<ImportBatch>(`/imports/batches/${batchId}/corrections`, payload).then((r) => r.data),
  /** 整批驳回（终态）：仅未确认批次可驳回；已确认走回滚/更正。 */
  reject: (batchId: number, reason: string) =>
    api.post<ImportBatch>(`/imports/batches/${batchId}/reject`, { reason }).then((r) => r.data),
};
