import { api } from "./client";
import type { Cashflow, Deposit, Installment, InstallmentCancelResult, InstallmentDisposition, InstallmentScheduleInput, Schedule } from "./types";

export const installmentsApi = {
  dispositions: (id: number) => api.get<InstallmentDisposition[]>(`/installments/${id}/dispositions`).then(r => r.data),
  recover: (id: number, data: {occurred_on: string; note: string; form_extra?: Record<string, unknown>}) => api.post<InstallmentDisposition>(`/installments/${id}/recover`, data).then(r => r.data),
  /** 回收转售登记：把已回收账号的新售出订单关联回分期合约（后端只认 resale_order_id）。 */
  resale: (id: number, data: {resale_order_id: number; occurred_on: string; note: string; form_extra?: Record<string, unknown>}) => api.post<InstallmentDisposition>(`/installments/${id}/resale`, data).then(r => r.data),
  list: (params?: { status?: string; order_id?: number }) =>
    api.get<Installment[]>("/installments", { params }).then((r) => r.data),
  exportCsv: (params?: { status?: string; order_id?: number }) =>
    api
      .get<Blob>("/installments/export.csv", {
        params: { ...params, _t: Date.now() },
        responseType: "blob",
      })
      .then((r) => r.data),
  create: (payload: Partial<Installment> & { first_due_on: string; adjust_final_period?: boolean; schedule?: InstallmentScheduleInput[] }) =>
    api.post<Installment>("/installments", payload).then((r) => r.data),
  schedules: (id: number) =>
    api.get<Schedule[]>(`/installments/${id}/schedules`).then((r) => r.data),
  pay: (
    id: number,
    payload: { amount: string; paid_on: string; period_no?: number; pool_id?: number; note?: string; form_extra?: Record<string, unknown> },
  ) =>
    api
      .post<{ installment: Installment; schedule: Schedule }>(
        `/installments/${id}/payments`,
        payload,
      )
      .then((r) => r.data),
  cancel: (id: number, payload: { cancelled_on: string; reason: string; form_extra?: Record<string, unknown> }) =>
    api.post<InstallmentCancelResult>(`/installments/${id}/cancel`, payload).then((r) => r.data),
  settleEarly: (id: number, payload: { paid_on: string; pool_id?: number; note?: string; form_extra?: Record<string, unknown> }) =>
    api.post<Installment>(`/installments/${id}/settle-early`, payload).then((r) => r.data),
  markDefault: (id: number, payload: { reason: string; form_extra?: Record<string, unknown> }) =>
    api.post<Installment>(`/installments/${id}/default`, payload).then((r) => r.data),
  waiveSchedule: (id: number, periodNo: number, payload: { amount: string; waived_on: string; reason: string; form_extra?: Record<string, unknown> }) =>
    api.post<Schedule>(`/installments/${id}/schedules/${periodNo}/waive`, payload).then((r) => r.data),
  extendSchedule: (id: number, periodNo: number, payload: { new_due_on: string; reason: string; form_extra?: Record<string, unknown> }) =>
    api.post<Schedule>(`/installments/${id}/schedules/${periodNo}/extend`, payload).then((r) => r.data),
  markOverdue: (asOf?: string) =>
    api.post<{ marked: number }>("/installments/mark-overdue", undefined, { params: asOf ? { as_of: asOf } : undefined }).then((r) => r.data),
  deliver: (id: number, payload: { delivery_mode: string; delivered_on: string; note: string; bound_phone?: string; bound_phone_owner?: string; form_extra?: Record<string, unknown> }) =>
    api.post<Installment>(`/installments/${id}/deliver`, payload).then((r) => r.data),
};

export const depositsApi = {
  list: (params?: { pool_id?: number }) =>
    api.get<Deposit[]>("/deposits", { params }).then((r) => r.data),
  create: (payload: Partial<Deposit> & { pool_id: number; amount: string; paid_on: string }) =>
    api.post<Deposit>("/deposits", payload).then((r) => r.data),
  release: (id: number, payload: { amount: string; released_on: string }) =>
    api.post<Deposit>(`/deposits/${id}/returns`, payload).then((r) => r.data),
  loss: (id: number, payload: { amount: string; lost_on: string; category: string; reason: string }) =>
    api.post<Cashflow>(`/deposits/${id}/losses`, payload).then((r) => r.data),
  /** 取消押金：仅未发生退还/损失的 PAID 押金；服务端全额写 DEPOSIT_CANCEL 冲正流水。 */
  cancel: (id: number, payload: { cancelled_on: string; reason: string }) =>
    api.post<Deposit>(`/deposits/${id}/cancel`, payload).then((r) => r.data),
};
