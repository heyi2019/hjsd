import { api } from "./client";
import type { TransferResult } from "./types/finance";

export const transfersApi = {
  create: (data: Record<string, unknown>) => api.post<TransferResult>("/transfers", data).then(r => r.data),
  repair: (transferId: string, data: { counterpart_pool_id: number; reason: string; operator_user_ids?: number[] }) =>
    api.post<TransferResult>(`/transfers/${transferId}/repair`, data).then(r => r.data),
};
