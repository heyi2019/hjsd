import { useCallback, useMemo, useRef, useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import {
  cashflowsApi,
  depositsApi,
  poolsApi,
  reconciliationsApi,
  type Cashflow,
  type Deposit,
  type Pool,
  type PoolBalance,
  type PoolBalanceTotals,
  type Reconciliation,
} from "../shared/api/catalog";
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
  // 资金流向（nature）从 CASHFLOW_NATURE 词典读取，设置页改文案可同步；词典未加载时回落 NATURE_LABEL。
  const natureOptionSet = useOptionSet("CASHFLOW_NATURE");

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

  // 资金流水：筛选全部走服务端（对齐 finance/router.py list_cashflows 的 12 个参数），
  // 避免 2000 条上限把池/方向/状态之外的结果挡在客户端之外。
  const cashflowKeywordRef = useRef(cashflowKeyword);
  cashflowKeywordRef.current = cashflowKeyword;

  const fetchCashflows = useCallback(async () => {
    setCashflowsReady(false);
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
    setCashflowTotals({
      income: result.total_in ?? "0.00",
      expense: result.total_out ?? "0.00",
    });
    setCashflowsReady(true);
  }, []);

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

  // 总收入 / 总支出：默认取服务端合计（与列表同一套筛选条件、不受 2000 条上限影响）。
  // 若用户刚改了筛选但还没点「查询」，列表已在本地即时收窄，此时合计同步按可见行求和，
  // 保证卡片数字与眼睛看到的行一致；一旦点「查询」，服务端值重新接管。
  const cashflowLocallyNarrowed = visibleCashflows.length !== cashflows.length;
  const sumVisible = (directionValue: "IN" | "OUT") => visibleCashflows
    .filter((row) => row.direction === directionValue)
    .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;
  const totalFlowIncome = cashflowLocallyNarrowed ? sumVisible("IN").toFixed(2) : cashflowTotals.income;
  const totalFlowExpense = cashflowLocallyNarrowed ? sumVisible("OUT").toFixed(2) : cashflowTotals.expense;

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
    natureOptionSet,
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
