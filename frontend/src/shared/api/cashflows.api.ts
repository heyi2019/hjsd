import { api } from "./client";
import type { Cashflow } from "./types";

export const cashflowsApi = {
  create: (data: Record<string, unknown>) => api.post<Cashflow>("/cashflows", data).then(r => r.data),
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
    limit?: number;
    offset?: number;
  }) =>
    api.get<{ items: Cashflow[]; total: number }>("/cashflows", { params }).then((r) => r.data),
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
  }) =>
    api
      .get<Blob>("/cashflows/export.csv", {
        params: { ...params, _t: Date.now() },
        responseType: "blob",
      })
      .then((r) => r.data),
};
