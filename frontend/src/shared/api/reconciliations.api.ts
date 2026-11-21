import { api } from "./client";
import type { Reconciliation } from "./types/finance";

export const reconciliationsApi = {
  page: (params: { limit: number; offset: number }) =>
    api.get<{ items: Reconciliation[]; total: number; limit: number; offset: number }>("/reconciliations/page", { params }).then((r) => r.data),
  list: () => api.get<Reconciliation[]>("/reconciliations").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Reconciliation>("/reconciliations", data).then(r => r.data),
  resolve: (id: number, reason: string, operator_user_ids?: number[], form_extra?: Record<string, unknown>) =>
    api.post<Reconciliation>(`/reconciliations/${id}/resolve`, { reason, operator_user_ids, form_extra }).then(r => r.data),
};
