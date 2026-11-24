import { api } from "./client";
import { idempotencyConfig } from "./idempotency";
import type { Cashflow } from "./types/finance";

export const orderCashflowsApi = {
  create: (orderId: number, data: Record<string, unknown>, key?: string) =>
    api.post<Cashflow>(`/orders/${orderId}/cashflows`, data, idempotencyConfig(key)).then((r) => r.data),
};
