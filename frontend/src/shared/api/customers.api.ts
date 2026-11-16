import { api } from "./client";
import type { PageResponse } from "./types/common";
import type { Counterparty, Customer, CustomerDetail, CustomerSummary, DuplicateCandidate, Lead, LeadSummary } from "./types/customers";

type CustomerListParams = { keyword?: string; status?: string; limit?: number; offset?: number };

const customerPage = (params?: CustomerListParams) =>
  api.get<PageResponse<Customer>>("/customers", {
    params: { limit: 10, offset: 0, ...params },
  }).then((r) => r.data);

export const customersApi = {
  summary: (params: { today_date: string; keyword?: string; status?: string }) =>
    api.get<CustomerSummary>("/customers/summary", { params }).then((r) => r.data),
  /** 返回一个后端分页窗口，默认只请求当前列表页。 */
  page: (params?: CustomerListParams) => customerPage(params),
  /** 仅供下拉选择器读取一个有界选项窗口。 */
  list: (params?: CustomerListParams): Promise<Customer[]> =>
    customerPage({ limit: 500, ...params }).then((response) => response.items),
  create: (payload: Partial<Customer>) =>
    api.post<{ customer: Customer; duplicate_candidates: DuplicateCandidate[] }>(
      "/customers",
      payload,
    ).then((r) => r.data),
  detail: (id: number) => api.get<CustomerDetail>(`/customers/${id}/detail`).then((r) => r.data),
  patch: (id: number, payload: Partial<Customer>) =>
    api.patch<Customer>(`/customers/${id}`, payload).then((r) => r.data),
  setStatus: (id: number, status: string) =>
    api.patch<Customer>(`/customers/${id}/status`, { status }).then((r) => r.data),
  merge: (id: number, target_customer_id: number, reason: string) =>
    api.post<Customer>(`/customers/${id}/merge`, { target_customer_id, reason }).then((r) => r.data),
  exportCsv: (params?: { keyword?: string; status?: string }) =>
    api
      .get<Blob>("/customers/export.csv", {
        params: { ...params, _t: Date.now() },
        responseType: "blob",
      })
      .then((r) => r.data),
};

export const counterpartiesApi = {
  list: (params?: { type?: string; status?: string }) =>
    api.get<Counterparty[]>("/counterparties", { params }).then((r) => r.data),
  page: (params?: { type?: string; status?: string; limit?: number; offset?: number }) =>
    api.get<PageResponse<Counterparty>>("/counterparties/page", {
      params: { limit: 10, offset: 0, ...params },
    }).then((r) => r.data),
  create: (payload: Partial<Counterparty>) =>
    api.post<Counterparty>("/counterparties", payload).then((r) => r.data),
  get: (id: number) => api.get<Counterparty>(`/counterparties/${id}`).then((r) => r.data),
  patch: (id: number, payload: Partial<Counterparty>) =>
    api.patch<Counterparty>(`/counterparties/${id}`, payload).then((r) => r.data),
  setStatus: (id: number, active: boolean) =>
    api.patch<Counterparty>(`/counterparties/${id}/status`, { active }).then((r) => r.data),
};

export const leadsApi = {
  page: (params?: { limit?: number; offset?: number; status?: string; keyword?: string; customer_id?: number }) =>
    api.get<PageResponse<Lead>>("/leads/page", {
      params: { limit: 10, offset: 0, ...params },
    }).then((r) => r.data),
  summary: () => api.get<LeadSummary>("/leads/summary").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Lead>("/leads", data).then(r => r.data),
  close: (id: number, reason: string, extra_values?: Record<string, unknown>, operator_user_ids?: number[]) => api.post<Lead>(`/leads/${id}/close`, { reason, extra_values, operator_user_ids }).then(r => r.data),
  convert: (id: number, order_id: number, extra_values?: Record<string, unknown>, operator_user_ids?: number[]) => api.post<Lead>(`/leads/${id}/convert`, { order_id, extra_values, operator_user_ids }).then(r => r.data),
};
