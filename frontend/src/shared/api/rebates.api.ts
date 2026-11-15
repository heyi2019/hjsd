import { api } from "./client";
import type { Rebate, RebateReturnResult } from "./types/finance";

export const rebatesApi = {
  list: (params?: { source_order_id?: number }) =>
    api.get<Rebate[]>("/rebates", { params }).then((r) => r.data),
  exportCsv: () =>
    api
      .get<Blob>("/rebates/export.csv", { params: { _t: Date.now() }, responseType: "blob" })
      .then((r) => r.data),
  create: (payload: Partial<Rebate> & {
    source_order_id: number;
    rebate_type: "BUY" | "SELL";
    amount: string;
    collected_on: string;
    operator_user_ids?: number[];
    channel?: string;
    note?: string;
    form_extra?: Record<string, unknown>;
  }) =>
    api.post<Rebate>("/rebates", payload).then((r) => r.data),
  update: (id: number, payload: { amount?: string; collected_on?: string; note?: string | null; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.patch<Rebate>(`/rebates/${id}`, payload).then((r) => r.data),
  /** 返点退回：登记即确认收入不提供作废；退回在来源订单记一笔真实挂单 OUT（REB-01）。 */
  returnRebate: (id: number, payload: { amount: string; returned_on: string; note?: string | null }) =>
    api.post<RebateReturnResult>(`/rebates/${id}/return`, payload).then((r) => r.data),
  // 2026-11-12 裁决：返点登记即确认收入，不提供删除/作废；退回走专用接口（累计≤金额、同源归期）。
};
