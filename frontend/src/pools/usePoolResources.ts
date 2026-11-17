import { useCallback, useState } from "react";
import { poolsApi } from "../shared/api/pools.api";
import type { Pool, PoolBalance, PoolBalanceTotals } from "../shared/api/types/finance";

/** 资金账户读取域：资金账户主数据、余额明细与服务端汇总。 */
export function usePoolResources() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [balanceTotals, setBalanceTotals] = useState<PoolBalanceTotals | null>(null);

  const loadPools = useCallback(async () => {
    const [list, overview] = await Promise.all([poolsApi.list(), poolsApi.balances()]);
    setPools(list);
    setBalances(Object.fromEntries(overview.items.map((item) => [item.pool_id, item])));
    setBalanceTotals(overview.totals);
  }, []);

  return { pools, balances, balanceTotals, loadPools };
}
