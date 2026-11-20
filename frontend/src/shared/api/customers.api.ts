import { api, type CacheAwareRequestConfig } from "./client";
import type { PageResponse } from "./types/common";
import type { Counterparty, Customer, CustomerDetail, CustomerSummary, DuplicateCandidate, Lead, LeadSummary } from "./types/customers";

type CreatedDateFilter = { created_from?: string; created_to?: string };
type CustomerFilterParams = CreatedDateFilter & { keyword?: string; status?: string; created_by?: string[]; mine_orders?: boolean; trade_date_from?: string; trade_date_to?: string };
type CustomerListParams = CustomerFilterParams & { limit?: number; offset?: number; sort_desc?: boolean };
export type CustomerOption = Pick<Customer, "id" | "customer_no" | "display_name">;

const customerPage = (params?: CustomerListParams) =>
  api.get<PageResponse<Customer>>("/customers", {
    params: { limit: 10, offset: 0, ...params },
    paramsSerializer: { indexes: null },
  }).then((r) => r.data);

export const customersApi = {
  options: (keyword = "", exact = false) => {
    const config: CacheAwareRequestConfig = { params: { keyword, ...(exact ? { exact: true } : {}) }, ...(exact ? { refreshCache: true } : {}) };
    return api.get<CustomerOption[]>("/customers/options", config).then((r) => r.data);
  },
  summary: (params: CustomerFilterParams & { today_date: string }) =>
    api.get<CustomerSummary>("/customers/summary", { params, paramsSerializer: { indexes: null } }).then((r) => r.data),
  /** 返回一个后端分页窗口，默认只请求当前列表页。 */
  page: (params?: CustomerListParams) => customerPage(params),
  /** 分批读取符合条件的全部客户，limit 为每次请求数量。 */
  list: async (params?: CustomerListParams): Promise<Customer[]> => {
    const items: Customer[] = [];
    const offset = params?.offset ?? 0;
    const limit = Math.min(params?.limit ?? 500, 500);
    while (true) {
      const page = await customerPage({ ...params, limit, offset: offset + items.length });
      if (!page.items.length && offset + items.length < page.total) throw new Error("客户名单读取不完整，请重试");
      items.push(...page.items);
      if (offset + items.length >= page.total) return items;
    }
  },
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
  exportCsv: (params?: CustomerFilterParams) =>
    api
      .get<Blob>("/customers/export.csv", {
        params: { ...params, _t: Date.now() },
        paramsSerializer: { indexes: null },
        responseType: "blob",
      })
      .then((r) => r.data),
};

export const counterpartiesApi = {
  list: (params?: CreatedDateFilter & { type?: string; status?: string; created_by?: string[] }) =>
    api.get<Counterparty[]>("/counterparties", { params, paramsSerializer: { indexes: null } }).then((r) => r.data),
  page: (params?: CreatedDateFilter & { type?: string; status?: string; created_by?: string[]; keyword?: string; limit?: number; offset?: number; sort_desc?: boolean }) =>
    api.get<PageResponse<Counterparty>>("/counterparties/page", {
      params: { limit: 10, offset: 0, ...params },
      paramsSerializer: { indexes: null },
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
  page: (params?: CreatedDateFilter & { limit?: number; offset?: number; status?: string; keyword?: string; customer_id?: number; sort_desc?: boolean }) =>
    api.get<PageResponse<Lead>>("/leads/page", {
      params: { limit: 10, offset: 0, ...params },
    }).then((r) => r.data),
  summary: (params?: CreatedDateFilter & { keyword?: string }) => api.get<LeadSummary>("/leads/summary", { params }).then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Lead>("/leads", data).then(r => r.data),
  close: (id: number, reason: string, extra_values?: Record<string, unknown>, operator_user_ids?: number[]) => api.post<Lead>(`/leads/${id}/close`, { reason, extra_values, operator_user_ids }).then(r => r.data),
  convert: (id: number, order_no: string, extra_values?: Record<string, unknown>, operator_user_ids?: number[]) => api.post<Lead>(`/leads/${id}/convert`, { order_no, extra_values, operator_user_ids }).then(r => r.data),
};
