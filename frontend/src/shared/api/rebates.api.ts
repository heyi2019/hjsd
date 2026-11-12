import { api } from "./client";
import type { Rebate } from "./types";

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
    base_amount: string;
    collected_on: string;
    operator_user_ids?: number[];
    channel?: string;
    note?: string;
    form_extra?: Record<string, unknown>;
  }) =>
    api.post<Rebate>("/rebates", payload).then((r) => r.data),
  update: (id: number, payload: { base_amount?: string; rate?: string; collected_on?: string; note?: string | null; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.patch<Rebate>(`/rebates/${id}`, payload).then((r) => r.data),
  // 2026-11-12 裁决：返点登记即确认收入，不提供删除/作废。退回走资金中心录入 OUT 支出。
};
