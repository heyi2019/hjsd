import { api } from "./client";
import { idempotencyConfig } from "./idempotency";
import type { PageResponse } from "./types/common";
import type { Installment, InstallmentCancelResult, InstallmentDisposition, InstallmentScheduleInput, InstallmentTotals, Schedule } from "./types/installments";
import type { SaleCustomerInput } from "./orders-api/orders";

/** 分期列表与合计共用同一套筛选条件：改一处即两处同步，杜绝「列表按新条件、合计按旧条件」。 */
export interface InstallmentListParams {
  status?: string;
  order_id?: number;
  contract_type?: string;
  trade_date_from?: string;
  trade_date_to?: string;
}

export const installmentsApi = {
  previewSalePlan: (payload: { sale_amount: string; down_payment: string; service_fee: string; periods: number; per_period?: string }) =>
    api.post<SaleInstallmentPlan>("/installments/plan", payload).then((r) => r.data),
  recover: (id: number, data: {occurred_on: string; recovery_cost: string; note: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown>}) => api.post<InstallmentDisposition>(`/installments/${id}/recover`, data).then(r => r.data),
  page: (params: InstallmentListParams & { limit: number; offset: number; sort_desc: boolean }) =>
    api.get<PageResponse<Installment>>("/installments", { params }).then((r) => r.data),
  updateOperationOperators: (id: number, operationKey: string, operator_user_ids: number[]) =>
    api.put<Installment>(`/installments/${id}/operation-operators/${encodeURIComponent(operationKey)}`, { operator_user_ids }).then((r) => r.data),
  /** 分期台合计：与 page 共用筛选参数，服务端 Decimal 聚合。 */
  totals: (params?: InstallmentListParams) =>
    api
      .get<InstallmentTotals>("/installments/totals", { params })
      .then((r) => r.data),
  exportCsv: (params?: InstallmentListParams) =>
    api
      .get<Blob>("/installments/export.csv", {
        params: { ...params, _t: Date.now() },
        responseType: "blob",
      })
      .then((r) => r.data),
  stockSale: (payload: Partial<Installment> & { order_id: number; first_due_on: string; paid_on: string; pool_id?: number; adjust_final_period?: boolean; schedule?: InstallmentScheduleInput[]; operator_user_ids?: number[]; customer_input?: SaleCustomerInput; delivery_form_extra?: Record<string, unknown>; form_extra?: Record<string, unknown> }, key?: string) =>
    api.post<Installment>("/installments/stock-sale", payload, idempotencyConfig(key)).then((r) => r.data),
  pay: (
    id: number,
    payload: { amount: string; paid_on: string; period_no?: number; pool_id?: number; note?: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> },
  ) =>
    api
      .post<{ installment: Installment; schedule: Schedule }>(
        `/installments/${id}/payments`,
        payload,
      )
      .then((r) => r.data),
  cancel: (id: number, payload: { cancelled_on: string; reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }, origin?: "ORDER") =>
    api.post<InstallmentCancelResult>(`/installments/${id}/${origin === "ORDER" ? "order-cancel" : "cancel"}`, payload).then((r) => r.data),
  settleEarly: (id: number, payload: { paid_on: string; pool_id?: number; note?: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Installment>(`/installments/${id}/settle-early`, payload).then((r) => r.data),
  markDefault: (id: number, payload: { reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Installment>(`/installments/${id}/default`, payload).then((r) => r.data),
  waiveSchedule: (id: number, periodNo: number, payload: { amount: string; waived_on: string; reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Schedule>(`/installments/${id}/schedules/${periodNo}/waive`, payload).then((r) => r.data),
  extendSchedule: (id: number, periodNo: number, payload: { new_due_on: string; reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Schedule>(`/installments/${id}/schedules/${periodNo}/extend`, payload).then((r) => r.data),
  markOverdue: (asOf?: string) =>
    api.post<{ marked: number }>("/installments/mark-overdue", undefined, { params: asOf ? { as_of: asOf } : undefined }).then((r) => r.data),
  deliver: (id: number, payload: { delivered_on: string; note: string; bound_phone?: string; bound_phone_owner?: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.post<Installment>(`/installments/${id}/deliver`, payload).then((r) => r.data),
};

export interface SaleInstallmentPlan {
  principal: string;
  down_payment: string;
  service_fee: string;
  periods: number;
  base_amount: string;
  total_schedule_amount: string;
  per_period: string;
  last_period: string;
  per_period_service_fee: string;
  per_period_matches: boolean | null;
}
