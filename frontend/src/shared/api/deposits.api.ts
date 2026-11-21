import { api } from "./client";
import type { Cashflow, Deposit } from "./types/finance";

export const depositsApi = {
  page: (params: { limit: number; offset: number }) =>
    api.get<{ items: Deposit[]; total: number; limit: number; offset: number }>("/deposits/page", { params }).then((r) => r.data),
  list: (params?: { pool_id?: number }) =>
    api.get<Deposit[]>("/deposits", { params }).then((r) => r.data),
  create: (payload: Partial<Deposit> & { pool_id: number; amount: string; paid_on: string }) =>
    api.post<Deposit>("/deposits", payload).then((r) => r.data),
  update: (id: number, payload: Partial<Deposit> & { pool_id: number; amount: string; paid_on: string }) =>
    api.put<Deposit>(`/deposits/${id}`, payload).then((r) => r.data),
  remove: (id: number) => api.delete(`/deposits/${id}`),
  release: (id: number, payload: { amount: string; released_on: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Deposit>(`/deposits/${id}/returns`, payload).then((r) => r.data),
  loss: (id: number, payload: { amount: string; lost_on: string; category: string; reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Cashflow>(`/deposits/${id}/losses`, payload).then((r) => r.data),
  /** 取消押金：仅未发生退还/损失的 PAID 押金；服务端全额写 DEPOSIT_CANCEL 冲正流水。 */
  cancel: (id: number, payload: { cancelled_on: string; reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Deposit>(`/deposits/${id}/cancel`, payload).then((r) => r.data),
};
