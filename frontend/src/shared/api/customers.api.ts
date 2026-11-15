import { api } from "./client";
import type { PageResponse } from "./types/common";
import type { Counterparty, Customer, CustomerDetail, CustomerSummary, DuplicateCandidate, Lead, LeadSummary } from "./types/customers";

export const customersApi = {
  summary: (params: { today_date: string; keyword?: string; status?: string }) =>
    api.get<CustomerSummary>("/customers/summary", { params }).then((r) => r.data),
  list: async (params?: { keyword?: string; status?: string; limit?: number; offset?: number }): Promise<Customer[]> => {
    if (params?.limit != null) {
      return api.get<PageResponse<Customer>>("/customers", { params }).then((r) => r.data.items);
    }
    const all: Customer[] = [];
    const PAGE = 500;
    for (let i = 0; i < 50; i++) {
      const page = await api.get<PageResponse<Customer>>("/customers", {
        params: { ...params, limit: PAGE, offset: i * PAGE },
      }).then((r) => r.data.items);
      all.push(...page);
      if (page.length < PAGE) break;
    }
    return all;
  },
  create: (payload: Partial<Customer>) =>
    api.post<{ customer: Customer; duplicate_candidates: DuplicateCandidate[] }>(
      "/customers",
      payload,
    ).then((r) => r.data),
  get: (id: number, reveal = false) =>
    api.get<Customer>(`/customers/${id}`, { params: { reveal } }).then((r) => r.data),
  detail: (id: number, reveal = false) =>
    api.get<CustomerDetail>(`/customers/${id}/detail`, { params: { reveal } }).then((r) => r.data),
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
  create: (payload: Partial<Counterparty>) =>
    api.post<Counterparty>("/counterparties", payload).then((r) => r.data),
  get: (id: number) => api.get<Counterparty>(`/counterparties/${id}`).then((r) => r.data),
  patch: (id: number, payload: Partial<Counterparty>) =>
    api.patch<Counterparty>(`/counterparties/${id}`, payload).then((r) => r.data),
  setStatus: (id: number, active: boolean) =>
    api.patch<Counterparty>(`/counterparties/${id}/status`, { active }).then((r) => r.data),
};

export const leadsApi = {
  list: () => api.get<Lead[]>("/leads").then(r => r.data),
  summary: () => api.get<LeadSummary>("/leads/summary").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Lead>("/leads", data).then(r => r.data),
  close: (id: number, reason: string, extra_values?: Record<string, unknown>) => api.post<Lead>(`/leads/${id}/close`, { reason, extra_values }).then(r => r.data),
  convert: (id: number, order_id: number, extra_values?: Record<string, unknown>) => api.post<Lead>(`/leads/${id}/convert`, { order_id, extra_values }).then(r => r.data),
};
