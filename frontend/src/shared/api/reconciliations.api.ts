import { api } from "./client";
import type { Reconciliation } from "./types/finance";

export const reconciliationsApi = {
  list: () => api.get<Reconciliation[]>("/reconciliations").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Reconciliation>("/reconciliations", data).then(r => r.data),
  resolve: (id: number, reason: string, operator_user_ids?: number[]) => api.post<Reconciliation>(`/reconciliations/${id}/resolve`, { reason, operator_user_ids }).then(r => r.data),
};
