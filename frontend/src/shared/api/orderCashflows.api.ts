import { api } from "./client";
import type { Cashflow } from "./types/finance";

export const orderCashflowsApi = {
  create: (orderId: number, data: Record<string, unknown>) =>
    api.post<Cashflow>(`/orders/${orderId}/cashflows`, data).then((r) => r.data),
};
