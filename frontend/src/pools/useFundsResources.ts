import { useCallback, useState } from "react";
import { depositsApi } from "../shared/api/deposits.api";
import { poolsApi } from "../shared/api/pools.api";
import { reconciliationsApi } from "../shared/api/reconciliations.api";
import type { Deposit, Pool, PoolBalance, PoolBalanceTotals, Reconciliation } from "../shared/api/types/finance";
import { normalizeError } from "../shared/api/client";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { useCashflowResources } from "./useCashflowResources";

/** 资金中心数据/查询层：资金池、余额、押金、流水、对账的加载与筛选，以及派生统计。
 *  逐字切片自原 useFundsPageController，仅按职责归位；写操作见 useFundsFormActions。 */
export function useFundsResources(active = true) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  // 服务端汇总（Decimal 聚合）：总余额 / 可用 / 押金占用 / 自有权益，前端不再自己累加。
  const [balanceTotals, setBalanceTotals] = useState<PoolBalanceTotals | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [reconciliationsReady, setReconciliationsReady] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [fundsReady, setFundsReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const cashflow = useCashflowResources(active);

  const load = useCallback(async () => {
    setLoading(true);
    setFundsReady(false);
    setBalanceTotals(null);
    setReconciliationsReady(false);
    try {
      const list = await poolsApi.list();
      setPools(list);
      // 余额一次批量拿回（含服务端汇总）：原先逐池 N+1，再把卡片用浮点相加算总余额。
      const overview = await poolsApi.balances();
      setBalances(
        Object.fromEntries(overview.items.map((item) => [item.pool_id, item])),
      );
      setBalanceTotals(overview.totals);
      setDeposits(await depositsApi.list());
      await cashflow.fetchCashflows();
      setReconciliations(await reconciliationsApi.list());
      setReconciliationsReady(true);
      setError(null);
      setFundsReady(true);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [cashflow.fetchCashflows]);

  // keep-alive：建单（initial_buy/initial_costs）与退款都会生成资金流水，重新激活时重拉避免资金中心过期。
  useReloadOnActive(active, load);

  // 四张统计卡全部取服务端汇总（Decimal 聚合）：前端不再对卡片浮点累加，也不再有 N+1。
  // 自有权益口径（domain/enums.py PoolOwnership：OWNED 计入权益，CUSTODY/THIRD_PART 只计现金头寸）
  // 由后端按资金池主数据判定，权益按现金头寸计、不扣押金占用。
  const unavailableAmount = error ? "不可用" : "—";
  const totalCash = fundsReady && balanceTotals ? balanceTotals.cash_balance : unavailableAmount;
  const totalAvailable = fundsReady && balanceTotals ? balanceTotals.available : unavailableAmount;
  const totalDeposit = fundsReady && balanceTotals ? balanceTotals.deposit_held : unavailableAmount;
  const totalOwned = fundsReady && balanceTotals ? balanceTotals.owned_cash_balance : unavailableAmount;

  const totalFlowIncome = cashflow.cashflowTotals.income;
  const totalFlowExpense = cashflow.cashflowTotals.expense;

  return {
    pools,
    balances,
    deposits,
    ...cashflow,
    reconciliations,
    reconciliationsReady,
    loading,
    error,
    fundsReady,
    load,
    totalCash,
    totalAvailable,
    totalDeposit,
    totalOwned,
    totalFlowIncome,
    totalFlowExpense,
  };
}
