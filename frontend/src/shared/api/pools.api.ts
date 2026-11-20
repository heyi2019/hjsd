import { api } from "./client";
import type { Pool, PoolBalance, PoolBalanceTotals } from "./types/finance";
import { notifyReferenceDataChanged } from "../state/referenceDataEvents";

function poolChanged<T>(value: T): T {
  notifyReferenceDataChanged("pools");
  return value;
}

export const poolsApi = {
  update: (id: number, data: Partial<Pool>) => api.patch<Pool>(`/pools/${id}`, data).then(r => poolChanged(r.data)),
  setStatus: (id: number, status: string) => api.patch<Pool>(`/pools/${id}/status`, {status}).then(r => poolChanged(r.data)),
  list: () => api.get<Pool[]>("/pools").then((r) => r.data),
  create: (payload: Partial<Pool>) => api.post<Pool>("/pools", payload).then((r) => poolChanged(r.data)),
  remove: (id: number) => api.delete<void>(`/pools/${id}`).then(r => poolChanged(r.data)),
  balance: (poolId: number) =>
    api.get<PoolBalance>(`/pools/${poolId}/balance`).then((r) => r.data),
  /** 全部可见池的余额 + 服务端汇总；替代逐池 N+1 与前端累加。 */
  balances: () =>
    api
      .get<{ items: PoolBalance[]; totals: PoolBalanceTotals }>("/pools/balances")
      .then((r) => r.data),
};
