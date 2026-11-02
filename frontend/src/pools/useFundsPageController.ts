/** 资金中心逻辑层：集中所有状态、表单、写操作与派生计算，视图层（Tabs / Modals）通过 controller 消费。
 *  与 FundsPage.tsx 原组件体一一对应，仅把逻辑从组件作用域移到 hook 作用域，行为不变。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { useCompactLayout } from "../shared/ui";
import { Form } from "antd";
import {
  cashflowsApi,
  depositsApi,
  poolsApi,
  reconciliationsApi,
  transfersApi,
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
import { ACCOUNTING_ATTRIBUTE_LABEL } from "../shared/lib/labels";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { useOptionSet } from "../shared/lib/optionSets";
import { ALLOWED_ATTRIBUTES_BY_FUND_NATURE, deriveCashflowNature } from "./FundsPage.fragments";

export function useFundsPageController(active = true) {
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
  const [depositOpen, setDepositOpen] = useState(false);
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Reconciliation | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [lossTarget, setLossTarget] = useState<Deposit | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Deposit | null>(null);
  const [repairTarget, setRepairTarget] = useState<Cashflow | null>(null);
  const [unmatchedTarget, setUnmatchedTarget] = useState<Reconciliation | null>(null);
  const [cashflowKeyword, setCashflowKeyword] = useState("");
  const [cashflowPoolId, setCashflowPoolId] = useState<number | undefined>();
  const [cashflowDirection, setCashflowDirection] = useState<string | undefined>();
  const [cashflowStatus, setCashflowStatus] = useState<string | undefined>();
  const [cashflowFrom, setCashflowFrom] = useState("");
  const [cashflowTo, setCashflowTo] = useState("");
  const [cashflowFundNature, setCashflowFundNature] = useState("");
  const [cashflowAttribute, setCashflowAttribute] = useState("");
  const [cashflowCategory, setCashflowCategory] = useState("");
  const compact = useCompactLayout();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [fundsReady, setFundsReady] = useState(false);
  // T20：资金流水筛选项从「选项词典」配置读取（方向 / 状态 / 资金性质 / 核算属性）。
  const flowDirectionOptions = useOptionSet("FUND_FLOW_DIRECTION");
  const flowStatusOptions = useOptionSet("FUND_FLOW_STATUS");
  const flowFundNatureOptions = useOptionSet("FUND_FLOW_FUND_NATURE");
  const flowAttributeOptions = useOptionSet("FUND_FLOW_ACCOUNTING_ATTRIBUTE");
  // 资金流向（nature）从 CASHFLOW_NATURE 词典读取，设置页改文案可同步；词典未加载时回落 NATURE_LABEL。
  const natureOptionSet = useOptionSet("CASHFLOW_NATURE");
  // 弹窗不会同时打开，故全部写操作后共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  // L1527-①：全部资金弹窗共用同一 write.error。任一弹窗开/关切换时清除该错误，
  // 避免 A 弹窗提交失败后其 alert 在 B 弹窗（或重新打开 A）中残留。
  // 提交失败停留当前弹窗时 open 态不变，错误仍可见；仅状态切换（开/关）触发清理。
  useEffect(() => {
    write.clearError();
  }, [
    depositOpen,
    cashflowOpen,
    transferOpen,
    reconciliationOpen,
    resolveTarget,
    reverseTarget,
    returnTarget,
    lossTarget,
    cancelTarget,
    repairTarget,
    unmatchedTarget,
    write.clearError,
  ]);
  const [loading, setLoading] = useState(false);
  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();
  const [cashflowForm] = Form.useForm();
  const cashflowFormNature = Form.useWatch("fund_nature", cashflowForm) as string | undefined;
  const cashflowAttributeOptions = (
    ALLOWED_ATTRIBUTES_BY_FUND_NATURE[cashflowFormNature ?? "BUSINESS"]
    ?? Object.keys(ACCOUNTING_ATTRIBUTE_LABEL)
  ).map((value) => ({ value, label: ACCOUNTING_ATTRIBUTE_LABEL[value] ?? value }));
  const [transferForm] = Form.useForm();
  const [reconciliationForm] = Form.useForm();
  const [resolveForm] = Form.useForm();
  const [reverseForm] = Form.useForm();
  const [lossForm] = Form.useForm();
  const [cancelForm] = Form.useForm();
  const [repairForm] = Form.useForm();

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

  const submitDeposit = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      await depositsApi.create({
        pool_id: Number(values.pool_id),
        amount: values.amount as string,
        paid_on: values.paid_on as string,
        counterparty_id: values.counterparty_id ? Number(values.counterparty_id) : undefined,
        source_order_id: values.source_order_id ? Number(values.source_order_id) : undefined,
        expected_release_on: values.expected_release_on as string | undefined,
        note: values.note as string,
      });
      appMessage.success("押金占用已登记，不影响经营损益");
      setDepositOpen(false);
      depositForm.resetFields();
      await load();
    });
  };

  const submitReturn = async (values: Record<string, unknown>) => {
    if (!returnTarget) return;
    const targetId = returnTarget.id;
    await write.run(async () => {
      await depositsApi.release(targetId, {
        amount: values.amount as string,
        released_on: values.released_on as string,
      });
      appMessage.success("押金释放已登记");
      setReturnTarget(null);
      returnForm.resetFields();
      await load();
    });
  };

  const submitLoss = async (values: Record<string, unknown>) => {
    if (!lossTarget) return;
    const targetId = lossTarget.id;
    await write.run(async () => {
      await depositsApi.loss(targetId, {
        amount: values.amount as string,
        lost_on: values.lost_on as string,
        category: values.category as string,
        reason: values.reason as string,
      });
      appMessage.success("押金损失已登记");
      setLossTarget(null);
      lossForm.resetFields();
      await load();
    });
  };

  const submitCancelDeposit = async (values: Record<string, unknown>) => {
    if (!cancelTarget) return;
    const targetId = cancelTarget.id;
    await write.run(async () => {
      await depositsApi.cancel(targetId, {
        cancelled_on: values.cancelled_on as string,
        reason: values.reason as string,
      });
      appMessage.success("押金已取消，已生成全额冲正流水");
      setCancelTarget(null);
      cancelForm.resetFields();
      await load();
    });
  };

  const submitCashflow = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      const fundNature = String(values.fund_nature ?? "BUSINESS");
      const direction = String(values.direction ?? "IN");
      await cashflowsApi.create({
        pool_id: Number(values.pool_id),
        occurred_on: values.occurred_on as string,
        direction,
        nature: deriveCashflowNature(fundNature, direction),
        fund_nature: fundNature,
        accounting_attribute: String(values.accounting_attribute ?? "OPERATING_EXPENSE"),
        category: values.category as string,
        amount: values.amount as string,
        note: values.note as string,
      });
      appMessage.success("独立资金流水已提交，已入账");
      setCashflowOpen(false);
      cashflowForm.resetFields();
      await load();
    });
  };

  const reverseCashflow = async (values: Record<string, unknown>) => {
    if (!reverseTarget) return;
    const targetId = reverseTarget.id;
    await write.run(async () => {
      await cashflowsApi.reverse(targetId, {
        reversed_on: values.reversed_on as string,
        reason: values.reason as string,
      });
      appMessage.success("流水已冲销");
      setReverseTarget(null);
      reverseForm.resetFields();
      await load();
    });
  };

  const submitTransfer = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      const sourcePoolId = Number(values.source_pool_id);
      const targetPoolId = Number(values.target_pool_id);
      const amount = Number(values.amount);
      const available = balances[sourcePoolId]?.available;
      if (sourcePoolId === targetPoolId) {
        throw new Error("转入和转出资金池不能相同");
      }
      if (available != null && Number.isFinite(amount) && amount > Number(available) + 0.000001) {
        throw new Error("转出资金池可用余额不足");
      }
      await transfersApi.create({
        source_pool_id: sourcePoolId,
        target_pool_id: targetPoolId,
        amount: values.amount as string,
        occurred_on: values.occurred_on as string,
        note: values.note as string,
      });
      appMessage.success("资金池划转已登记");
      setTransferOpen(false);
      transferForm.resetFields();
      await load();
    });
  };

  const submitRepair = async (values: Record<string, unknown>) => {
    if (!repairTarget?.transfer_id) return;
    const targetId = repairTarget.transfer_id;
    await write.run(async () => {
      await transfersApi.repair(targetId, {
        counterpart_pool_id: Number(values.counterpart_pool_id),
        reason: values.reason as string,
      });
      appMessage.success("单边划转已修复");
      setRepairTarget(null);
      repairForm.resetFields();
      await load();
    });
  };

  const submitReconciliation = async (values: Record<string, unknown>) => {
    const poolId = Number(values.pool_id);
    const reconciledOn = values.reconciled_on as string;
    const accountLabel = (values.account_label as string).trim();
    // 唯一约束（domain/trade.py uq_reconciliations_scope：池+池内账户+日期+账户标签）客户端预检，
    // 命中重复即阻断并提示调整，避免用户直接吃到后端校验错误。
    if (
      reconciliations.some(
        (row) => row.pool_id === poolId && row.reconciled_on === reconciledOn && row.account_label === accountLabel,
      )
    ) {
      appMessage.warning("同一资金池、对账账户和日期只能对账一次，请调整对账日期或账户");
      return;
    }
    await write.run(async () => {
      const rawIds = String(values.unmatched_flow_ids ?? "").trim();
      await reconciliationsApi.create({
        pool_id: Number(values.pool_id),
        reconciled_on: values.reconciled_on as string,
        account_label: values.account_label as string,
        statement_balance: values.statement_balance as string,
        unmatched_flow_ids: rawIds ? rawIds.split(",").map((value) => Number(value.trim())).filter(Boolean) : [],
        reason: values.reason as string,
        note: values.note as string,
      });
      appMessage.success("对账记录已提交");
      setReconciliationOpen(false);
      reconciliationForm.resetFields();
      await load();
    });
  };

  const resolveReconciliation = async (values: Record<string, unknown>) => {
    if (!resolveTarget) return;
    const targetId = resolveTarget.id;
    await write.run(async () => {
      await reconciliationsApi.resolve(targetId, values.reason as string);
      appMessage.success("对账差异已核销");
      setResolveTarget(null);
      resolveForm.resetFields();
      await load();
    });
  };

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
    active,
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
    compact,
    depositOpen,
    setDepositOpen,
    cashflowOpen,
    setCashflowOpen,
    transferOpen,
    setTransferOpen,
    reconciliationOpen,
    setReconciliationOpen,
    resolveTarget,
    setResolveTarget,
    reverseTarget,
    setReverseTarget,
    returnTarget,
    setReturnTarget,
    lossTarget,
    setLossTarget,
    cancelTarget,
    setCancelTarget,
    repairTarget,
    setRepairTarget,
    unmatchedTarget,
    setUnmatchedTarget,
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
    cashflowAttributeOptions,
    depositForm,
    returnForm,
    cashflowForm,
    transferForm,
    reconciliationForm,
    resolveForm,
    reverseForm,
    lossForm,
    cancelForm,
    repairForm,
    fetchCashflows,
    exportCashflows,
    cashflowExporting,
    load,
    submitDeposit,
    submitReturn,
    submitLoss,
    submitCancelDeposit,
    submitCashflow,
    reverseCashflow,
    submitTransfer,
    submitRepair,
    submitReconciliation,
    resolveReconciliation,
    totalCash,
    totalAvailable,
    totalDeposit,
    totalOwned,
    visibleCashflows,
    transferAnomalies,
    totalFlowIncome,
    totalFlowExpense,
    write,
  };
}

export type FundsPageController = ReturnType<typeof useFundsPageController>;
