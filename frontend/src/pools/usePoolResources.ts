import { useCallback, useState } from "react";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";
import { poolsApi } from "../shared/api/pools.api";
import type { Pool, PoolBalance, PoolBalanceTotals } from "../shared/api/types/finance";

/** 资金账户读取域：资金账户主数据、余额明细与服务端汇总。 */
export function usePoolResources() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [balanceTotals, setBalanceTotals] = useState<PoolBalanceTotals | null>(null);
  const [fundsReady, setFundsReady] = useState(false);
  const [fundsLoading, setFundsLoading] = useState(false);
  const [fundsError, setFundsError] = useState<NormalizedError | null>(null);
  const request = useLatestRequest();

  const loadPools = useCallback(async () => {
    const id = request.start();
    setFundsReady(false);
    setFundsLoading(true);
    setFundsError(null);
    try {
      const [list, overview] = await Promise.all([poolsApi.list(), poolsApi.balances()]);
      if (!request.isCurrent(id)) return;
      setPools(list);
      setBalances(Object.fromEntries(overview.items.map((item) => [item.pool_id, item])));
      setBalanceTotals(overview.totals);
      setFundsReady(true);
    } catch (err) {
      if (request.isCurrent(id)) setFundsError(normalizeError(err));
    } finally {
      if (request.isCurrent(id)) setFundsLoading(false);
    }
  }, [request]);

  return { pools, balances, balanceTotals, fundsReady, fundsLoading, fundsError, loadPools };
}
