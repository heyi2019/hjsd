import { api } from "./client";
import type { Pool, PoolBalance, PoolBalanceTotals, Reconciliation, TransferResult } from "./types";

export const poolsApi = {
  update: (id: number, data: Partial<Pool>) => api.patch<Pool>(`/pools/${id}`, data).then(r => r.data),
  setStatus: (id: number, status: string) => api.patch<Pool>(`/pools/${id}/status`, {status}).then(r => r.data),
  list: () => api.get<Pool[]>("/pools").then((r) => r.data),
  create: (payload: Partial<Pool>) => api.post<Pool>("/pools", payload).then((r) => r.data),
  remove: (id: number) => api.delete<void>(`/pools/${id}`).then(r => r.data),
  balance: (poolId: number) =>
    api.get<PoolBalance>(`/pools/${poolId}/balance`).then((r) => r.data),
  /** 全部可见池的余额 + 服务端汇总；替代逐池 N+1 与前端累加。 */
  balances: () =>
    api
      .get<{ items: PoolBalance[]; totals: PoolBalanceTotals }>("/pools/balances")
      .then((r) => r.data),
};

export const transfersApi = {
  create: (data: Record<string, unknown>) => api.post<TransferResult>("/transfers", data).then(r => r.data),
  repair: (transferId: string, data: { counterpart_pool_id: number; reason: string }) =>
    api.post<TransferResult>(`/transfers/${transferId}/repair`, data).then(r => r.data),
};

export const reconciliationsApi = {
  list: () => api.get<Reconciliation[]>("/reconciliations").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Reconciliation>("/reconciliations", data).then(r => r.data),
  resolve: (id: number, reason: string) => api.post<Reconciliation>(`/reconciliations/${id}/resolve`, { reason }).then(r => r.data),
};
