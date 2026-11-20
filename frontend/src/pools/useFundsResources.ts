import { useCallback, useEffect, useRef, useState } from "react";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { useCashflowResources } from "./useCashflowResources";
import { useDepositResources } from "./useDepositResources";
import { usePoolResources } from "./usePoolResources";
import { useReconciliationResources } from "./useReconciliationResources";
import { employeesApi } from "../shared/api/org.api";
import type { EmployeeOption } from "../shared/api/types/org";
import type { PeriodState } from "../shared/state/businessPeriod";

/** 资金中心数据/查询层：资金账户、余额、押金、流水、对账的加载与筛选，以及派生统计。
 *  逐字切片自原 useFundsPageController，仅按职责归位；写操作见 useFundsFormActions。 */
export function useFundsResources(active: boolean, periodState: PeriodState, cashflowsActive: boolean) {
  const poolResources = usePoolResources();
  const depositResources = useDepositResources();
  const reconciliationResources = useReconciliationResources();
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const cashflowEnabled = cashflowsActive && periodState.ready;
  const cashflowEnabledRef = useRef(cashflowEnabled);
  cashflowEnabledRef.current = cashflowEnabled;
  const cashflow = useCashflowResources(cashflowEnabled, periodState);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(employeesApi.list())
      .then((items) => {
        if (!cancelled) setEmployees((items ?? []).filter((item) => item.is_active));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async (includeCashflow = true) => {
    await Promise.all([
      poolResources.loadPools(),
      depositResources.loadDeposits(),
      reconciliationResources.loadReconciliations(),
      ...(includeCashflow && cashflowEnabledRef.current ? [cashflow.fetchCashflows()] : []),
    ]);
  }, [cashflow.fetchCashflows, depositResources.loadDeposits, poolResources.loadPools, reconciliationResources.loadReconciliations]);

  // keep-alive：建单（initial_buy/initial_costs）与退款都会生成资金流水，重新激活时重拉避免资金中心过期。
  useReloadOnActive(active, () => load(false));

  // 四张统计卡全部取服务端汇总（Decimal 聚合）：前端不再对卡片浮点累加，也不再有 N+1。
  const unavailableAmount = poolResources.fundsError ? "不可用" : "—";
  const balanceTotals = poolResources.balanceTotals;
  const totalCash = poolResources.fundsReady && balanceTotals ? balanceTotals.cash_balance : unavailableAmount;
  const totalAvailable = poolResources.fundsReady && balanceTotals ? balanceTotals.available : unavailableAmount;
  const totalDeposit = poolResources.fundsReady && balanceTotals ? balanceTotals.deposit_held : unavailableAmount;

  const totalFlowIncome = cashflow.cashflowTotals.income;
  const totalFlowExpense = cashflow.cashflowTotals.expense;

  return {
    pools: poolResources.pools,
    employees,
    balances: poolResources.balances,
    deposits: depositResources.deposits,
    depositsReady: depositResources.depositsReady,
    depositsLoading: depositResources.depositsLoading,
    depositsError: depositResources.depositsError,
    reloadDeposits: depositResources.loadDeposits,
    ...cashflow,
    reconciliations: reconciliationResources.reconciliations,
    reconciliationsReady: reconciliationResources.reconciliationsReady,
    reconciliationsLoading: reconciliationResources.reconciliationsLoading,
    reconciliationsError: reconciliationResources.reconciliationsError,
    reloadReconciliations: reconciliationResources.loadReconciliations,
    fundsReady: poolResources.fundsReady,
    fundsLoading: poolResources.fundsLoading,
    fundsError: poolResources.fundsError,
    reloadFunds: poolResources.loadPools,
    load,
    totalCash,
    totalAvailable,
    totalDeposit,
    totalFlowIncome,
    totalFlowExpense,
  };
}
