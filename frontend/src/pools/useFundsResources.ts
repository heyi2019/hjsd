import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { cashflowsApi } from "../shared/api/cashflows.api";
import { depositsApi } from "../shared/api/installments.api";
import { poolsApi, reconciliationsApi } from "../shared/api/pools.api";
import type { Cashflow, Deposit, Pool, PoolBalance, PoolBalanceTotals, Reconciliation } from "../shared/api/types/finance";
import { normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { today } from "../shared/lib/format";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { useOptionSet } from "../shared/lib/optionSets";

/** 资金中心数据/查询层：资金池、余额、押金、流水、对账的加载与筛选，以及派生统计。
 *  逐字切片自原 useFundsPageController，仅按职责归位；写操作见 useFundsFormActions。 */
export function useFundsResources(active = true) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  // 服务端汇总（Decimal 聚合）：总余额 / 可用 / 押金占用 / 自有权益，前端不再自己累加。
  const [balanceTotals, setBalanceTotals] = useState<PoolBalanceTotals | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [cashflowTotal, setCashflowTotal] = useState(0);
  // 服务端合计（同筛选条件、不受 limit 影响）；本地即时收窄时回落到对可见行的求和。
  const [cashflowTotals, setCashflowTotals] = useState({ income: "0.00", expense: "0.00" });
  const [cashflowsReady, setCashflowsReady] = useState(false);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [reconciliationsReady, setReconciliationsReady] = useState(false);

  const [cashflowKeyword, setCashflowKeyword] = useState("");
  const [cashflowPoolId, setCashflowPoolId] = useState<number | undefined>();
  const [cashflowDirection, setCashflowDirection] = useState<string | undefined>();
  const [cashflowStatus, setCashflowStatus] = useState<string | undefined>();
  const [cashflowFrom, setCashflowFrom] = useState("");
  const [cashflowTo, setCashflowTo] = useState("");
  const [cashflowFundNature, setCashflowFundNature] = useState("");
  const [cashflowAttribute, setCashflowAttribute] = useState("");
  const [cashflowCategory, setCashflowCategory] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [fundsReady, setFundsReady] = useState(false);
  // T20：资金流水筛选项从「选项词典」配置读取（方向 / 状态 / 资金性质 / 核算属性）。
  const flowDirectionOptions = useOptionSet("FUND_FLOW_DIRECTION");
  const flowStatusOptions = useOptionSet("FUND_FLOW_STATUS");
  const flowFundNatureOptions = useOptionSet("FUND_FLOW_FUND_NATURE");
  const flowAttributeOptions = useOptionSet("FUND_FLOW_ACCOUNTING_ATTRIBUTE");
  const [loading, setLoading] = useState(false);

  // 用 ref 持有最新筛选值，使全局 load()（含写操作后刷新）也能套用当前筛选条件。
  const cashflowFromRef = useRef(cashflowFrom);
  cashflowFromRef.current = cashflowFrom;
  const cashflowToRef = useRef(cashflowTo);
  cashflowToRef.current = cashflowTo;
  const cashflowPoolIdRef = useRef(cashflowPoolId);
  cashflowPoolIdRef.current = cashflowPoolId;
  const cashflowDirectionRef = useRef(cashflowDirection);
  cashflowDirectionRef.current = cashflowDirection;
  const cashflowStatusRef = useRef(cashflowStatus);
  cashflowStatusRef.current = cashflowStatus;
  const cashflowFundNatureRef = useRef(cashflowFundNature);
  cashflowFundNatureRef.current = cashflowFundNature;
  const cashflowAttributeRef = useRef(cashflowAttribute);
  cashflowAttributeRef.current = cashflowAttribute;
  const cashflowCategoryRef = useRef(cashflowCategory);
  cashflowCategoryRef.current = cashflowCategory;
  const cashflowTotalsRequestRef = useRef(0);

  // 资金流水：筛选全部走服务端（对齐 finance/router.py list_cashflows 的 12 个参数），
  // 避免 2000 条上限把池/方向/状态之外的结果挡在客户端之外。
  const cashflowKeywordRef = useRef(cashflowKeyword);
  cashflowKeywordRef.current = cashflowKeyword;

  const fetchCashflows = useCallback(async () => {
    setCashflowsReady(false);
    const totalsRequestId = ++cashflowTotalsRequestRef.current;
    const result = await cashflowsApi.list({
      occurred_from: cashflowFromRef.current || undefined,
      occurred_to: cashflowToRef.current || undefined,
      pool_id: cashflowPoolIdRef.current ?? undefined,
      direction: cashflowDirectionRef.current || undefined,
      status: cashflowStatusRef.current || undefined,
      fund_nature: cashflowFundNatureRef.current || undefined,
      accounting_attribute: cashflowAttributeRef.current || undefined,
      category: cashflowCategoryRef.current.trim() || undefined,
      keyword: cashflowKeywordRef.current.trim() || undefined,
      limit: 2000,
      offset: 0,
    });
    setCashflows(result.items);
    setCashflowTotal(result.total);
    // 合计以服务端为准：同一套筛选条件下聚合，流水超过 limit 也不会静默少算。
    if (totalsRequestId === cashflowTotalsRequestRef.current) {
      setCashflowTotals({
        income: result.total_in ?? "0.00",
        expense: result.total_out ?? "0.00",
      });
    }
    setCashflowsReady(true);
  }, []);

  // 卡片汇总跟随当前筛选条件即时刷新，聚合始终由后端完成，不对已加载流水求和。
  useEffect(() => {
    if (!active) return;
    const requestId = ++cashflowTotalsRequestRef.current;
    const timer = window.setTimeout(() => {
      void cashflowsApi.totals({
        occurred_from: cashflowFrom || undefined,
        occurred_to: cashflowTo || undefined,
        pool_id: cashflowPoolId,
        direction: cashflowDirection || undefined,
        status: cashflowStatus || undefined,
        fund_nature: cashflowFundNature || undefined,
        accounting_attribute: cashflowAttribute || undefined,
        category: cashflowCategory.trim() || undefined,
        keyword: cashflowKeyword.trim() || undefined,
      }).then((result) => {
        if (requestId !== cashflowTotalsRequestRef.current) return;
        setCashflowTotals({ income: result.total_in, expense: result.total_out });
      }).catch(() => {
        if (requestId !== cashflowTotalsRequestRef.current) return;
        setCashflowTotals({ income: "不可用", expense: "不可用" });
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (cashflowTotalsRequestRef.current === requestId) {
        cashflowTotalsRequestRef.current += 1;
      }
    };
  }, [
    active,
    cashflowAttribute,
    cashflowCategory,
    cashflowDirection,
    cashflowFrom,
    cashflowFundNature,
    cashflowKeyword,
    cashflowPoolId,
    cashflowStatus,
    cashflowTo,
  ]);

  const [cashflowExporting, setCashflowExporting] = useState(false);
  const exportCashflows = async () => {
    setCashflowExporting(true);
    try {
      downloadBlob(
        await cashflowsApi.exportCsv({
          occurred_from: cashflowFromRef.current || undefined,
          occurred_to: cashflowToRef.current || undefined,
          pool_id: cashflowPoolIdRef.current ?? undefined,
          direction: cashflowDirectionRef.current || undefined,
          status: cashflowStatusRef.current || undefined,
          fund_nature: cashflowFundNatureRef.current || undefined,
          accounting_attribute: cashflowAttributeRef.current || undefined,
          category: cashflowCategoryRef.current.trim() || undefined,
          // 导出必须与列表同口径：keyword 也要带，否则筛关键词后导出的是全量。
          keyword: cashflowKeywordRef.current.trim() || undefined,
        }),
        `资金流水-${today()}.csv`,
      );
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setCashflowExporting(false);
    }
  };

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
      await fetchCashflows();
      setReconciliations(await reconciliationsApi.list());
      setReconciliationsReady(true);
      setError(null);
      setFundsReady(true);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchCashflows]);

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

  const visibleCashflows = useMemo(() => {
    const keyword = cashflowKeyword.trim().toLowerCase();
    return cashflows.filter((row) => {
      const searchable = [row.order_no, row.flow_no, row.category, row.note]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        (!keyword || searchable.includes(keyword))
        && (cashflowPoolId == null || row.pool_id === cashflowPoolId)
        && (!cashflowDirection || row.direction === cashflowDirection)
        && (!cashflowStatus || row.status === cashflowStatus)
        && (!cashflowFrom || row.occurred_on >= cashflowFrom)
        && (!cashflowTo || row.occurred_on <= cashflowTo)
      );
    });
  }, [cashflowDirection, cashflowFrom, cashflowKeyword, cashflowPoolId, cashflowStatus, cashflowTo, cashflows]);

  const transferAnomalies = useMemo(() => {
    const grouped = new Map<string, Cashflow[]>();
    for (const row of cashflows) {
      if (!row.transfer_id) continue;
      const rows = grouped.get(row.transfer_id) ?? [];
      rows.push(row);
      grouped.set(row.transfer_id, rows);
    }
    return [...grouped.entries()]
      .filter(([, rows]) => rows.length === 1)
      .map(([transfer_id, rows]) => ({ transfer_id, flow: rows[0] }));
  }, [cashflows]);

  const totalFlowIncome = cashflowTotals.income;
  const totalFlowExpense = cashflowTotals.expense;

  return {
    pools,
    balances,
    deposits,
    cashflows,
    cashflowTotal,
    cashflowsReady,
    reconciliations,
    reconciliationsReady,
    loading,
    error,
    fundsReady,
    cashflowKeyword,
    setCashflowKeyword,
    cashflowPoolId,
    setCashflowPoolId,
    cashflowDirection,
    setCashflowDirection,
    cashflowStatus,
    setCashflowStatus,
    cashflowFrom,
    setCashflowFrom,
    cashflowTo,
    setCashflowTo,
    cashflowFundNature,
    setCashflowFundNature,
    cashflowAttribute,
    setCashflowAttribute,
    cashflowCategory,
    setCashflowCategory,
    flowDirectionOptions,
    flowStatusOptions,
    flowFundNatureOptions,
    flowAttributeOptions,
    fetchCashflows,
    exportCashflows,
    cashflowExporting,
    load,
    totalCash,
    totalAvailable,
    totalDeposit,
    totalOwned,
    visibleCashflows,
    transferAnomalies,
    totalFlowIncome,
    totalFlowExpense,
  };
}
