import { useCallback, useEffect, useState } from "react";
import { normalizeError } from "../shared/api/client";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { useCashflowResources } from "./useCashflowResources";
import { useDepositResources } from "./useDepositResources";
import { usePoolResources } from "./usePoolResources";
import { useReconciliationResources } from "./useReconciliationResources";
import { employeesApi } from "../shared/api/org.api";
import type { EmployeeOption } from "../shared/api/types/org";

/** 资金中心数据/查询层：资金账户、余额、押金、流水、对账的加载与筛选，以及派生统计。
 *  逐字切片自原 useFundsPageController，仅按职责归位；写操作见 useFundsFormActions。 */
export function useFundsResources(active = true) {
  const poolResources = usePoolResources();
  const depositResources = useDepositResources();
  const reconciliationResources = useReconciliationResources();
  const [reconciliationsReady, setReconciliationsReady] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [fundsReady, setFundsReady] = useState(false);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const cashflow = useCashflowResources(active);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(employeesApi.list())
      .then((items) => {
        if (!cancelled) setEmployees((items ?? []).filter((item) => item.is_active));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setFundsReady(false);
    setReconciliationsReady(false);
    try {
      await poolResources.loadPools();
      await depositResources.loadDeposits();
      await cashflow.fetchCashflows();
      await reconciliationResources.loadReconciliations();
      setReconciliationsReady(true);
      setError(null);
      setFundsReady(true);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [cashflow.fetchCashflows, depositResources.loadDeposits, poolResources.loadPools, reconciliationResources.loadReconciliations]);

  // keep-alive：建单（initial_buy/initial_costs）与退款都会生成资金流水，重新激活时重拉避免资金中心过期。
  useReloadOnActive(active, load);

  // 四张统计卡全部取服务端汇总（Decimal 聚合）：前端不再对卡片浮点累加，也不再有 N+1。
  const unavailableAmount = error ? "不可用" : "—";
  const balanceTotals = poolResources.balanceTotals;
  const totalCash = fundsReady && balanceTotals ? balanceTotals.cash_balance : unavailableAmount;
  const totalAvailable = fundsReady && balanceTotals ? balanceTotals.available : unavailableAmount;
  const totalDeposit = fundsReady && balanceTotals ? balanceTotals.deposit_held : unavailableAmount;

  const totalFlowIncome = cashflow.cashflowTotals.income;
  const totalFlowExpense = cashflow.cashflowTotals.expense;

  return {
    pools: poolResources.pools,
    employees,
    balances: poolResources.balances,
    deposits: depositResources.deposits,
    ...cashflow,
    reconciliations: reconciliationResources.reconciliations,
    reconciliationsReady,
    loading,
    error,
    fundsReady,
    load,
    totalCash,
    totalAvailable,
    totalDeposit,
    totalFlowIncome,
    totalFlowExpense,
  };
}
