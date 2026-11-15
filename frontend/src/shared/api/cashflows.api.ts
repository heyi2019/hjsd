import { api } from "./client";
import type { Cashflow } from "./types/finance";

export const cashflowsApi = {
  create: (data: Record<string, unknown>) => api.post<Cashflow>("/cashflows", data).then(r => r.data),
  update: (id: number, data: Record<string, unknown>) => api.put<Cashflow>(`/cashflows/${id}`, data).then(r => r.data),
  remove: (id: number) => api.delete(`/cashflows/${id}`),
  createForOrder: (orderId: number, data: Record<string, unknown>) =>
    api.post<Cashflow>(`/orders/${orderId}/cashflows`, data).then(r => r.data),
  reverse: (id: number, data: {reversed_on: string; reason: string; form_extra?: Record<string, unknown>}) => api.post<Cashflow>(`/cashflows/${id}/reverse`, data).then(r => r.data),
  list: (params?: {
    pool_id?: number;
    order_id?: number;
    direction?: string;
    occurred_from?: string;
    occurred_to?: string;
    status?: string;
    nature?: string;
    fund_nature?: string;
    accounting_attribute?: string;
    category?: string;
    created_by?: string;
    keyword?: string;
    limit?: number;
    offset?: number;
  }) =>
    // total_in / total_out 由服务端按同一套筛选聚合，不受 limit 影响；前端不再对当页求和。
    api
      .get<{ items: Cashflow[]; total: number; total_in?: string; total_out?: string }>("/cashflows", { params })
      .then((r) => r.data),
  totals: (params?: {
    pool_id?: number;
    order_id?: number;
    direction?: string;
    occurred_from?: string;
    occurred_to?: string;
    status?: string;
    nature?: string;
    fund_nature?: string;
    accounting_attribute?: string;
    category?: string;
    created_by?: string;
    keyword?: string;
  }) => api.get<{ total_in: string; total_out: string }>("/cashflows/totals", { params }).then((r) => r.data),
  /**
   * 工作室收支面板：明细 + 已入账汇总一次取回。
   *
   * 「哪些流水算工作室收支」以及收入/支出/净额都在服务端算（`service.studio_summary`），
   * 前端不再拉两次、不再按 source 过滤、也不再 reduce。
   */
  studioSummary: (params?: {
    pool_ids?: string;
    occurred_from?: string;
    occurred_to?: string;
    category?: string;
    limit?: number;
  }) =>
    api
      .get<{
        items: Cashflow[];
        approved_income: string;
        approved_expense: string;
        approved_net: string;
        count: number;
      }>("/cashflows/studio-summary", { params })
      .then((r) => r.data),
  exportCsv: (params?: {
    pool_id?: number;
    order_id?: number;
    direction?: string;
    occurred_from?: string;
    occurred_to?: string;
    status?: string;
    nature?: string;
    fund_nature?: string;
    accounting_attribute?: string;
    category?: string;
    created_by?: string;
    keyword?: string;
  }) =>
    api
      .get<Blob>("/cashflows/export.csv", {
        params: { ...params, _t: Date.now() },
        responseType: "blob",
      })
      .then((r) => r.data),
};
