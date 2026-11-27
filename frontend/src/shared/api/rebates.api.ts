import { api } from "./client";
import { idempotencyConfig } from "./idempotency";
import type { Rebate } from "./types/finance";

export const rebatesApi = {
  list: (params?: { source_order_id?: number }) =>
    api.get<Rebate[]>("/rebates", { params }).then((r) => r.data),
  create: (payload: Partial<Rebate> & {
    source_order_id: number;
    rebate_type: "BUY" | "SELL";
    amount: string;
    collected_on: string;
    operator_user_ids?: number[];
    channel?: string;
    note?: string;
    form_extra?: Record<string, unknown>;
  }, key?: string) =>
    api.post<Rebate>("/rebates", payload, idempotencyConfig(key)).then((r) => r.data),
  update: (id: number, payload: { amount?: string; collected_on?: string; note?: string | null; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) =>
    api.patch<Rebate>(`/rebates/${id}`, payload).then((r) => r.data),
};
