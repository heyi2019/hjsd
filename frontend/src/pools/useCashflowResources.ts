import { useCallback, useEffect, useRef, useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { cashflowsApi } from "../shared/api/cashflows.api";
import type { Cashflow } from "../shared/api/types/finance";
import { normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { today } from "../shared/lib/format";
import { ACCOUNTING_ATTRIBUTE_LABEL } from "../shared/lib/labels";
import type { PeriodState } from "../shared/state/businessPeriod";

/** 收支方向固定两项（Direction 枚举），不依赖词典。 */
const FLOW_DIRECTION_OPTIONS = [
  { value: "IN", label: "收入" },
  { value: "OUT", label: "支出" },
];

/** 资金流水查询域：筛选、服务端汇总、导出和列表状态集中在这里。 */
export function useCashflowResources(active: boolean, periodState: PeriodState) {
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [cashflowTotal, setCashflowTotal] = useState(0);
  const [cashflowTotals, setCashflowTotals] = useState({ income: "0.00", expense: "0.00" });
  const [cashflowsReady, setCashflowsReady] = useState(false);
  const [cashflowLoading, setCashflowLoading] = useState(false);
  const [cashflowError, setCashflowError] = useState<{ message: string; code?: string } | null>(null);
  const [cashflowKeyword, setCashflowKeyword] = useState("");
  const [cashflowPoolId, setCashflowPoolId] = useState<number | undefined>();
  const [cashflowDirection, setCashflowDirection] = useState<string | undefined>();
  const cashflowFrom = periodState.period?.from ?? "";
  const cashflowTo = periodState.period?.to ?? "";
  const [cashflowLedgerType, setCashflowLedgerType] = useState("");
  const [cashflowAttribute, setCashflowAttribute] = useState("");
  const [cashflowCategory, setCashflowCategory] = useState("");
  const [cashflowExporting, setCashflowExporting] = useState(false);

  const cashflowFromRef = useRef(cashflowFrom);
  cashflowFromRef.current = cashflowFrom;
  const cashflowToRef = useRef(cashflowTo);
  cashflowToRef.current = cashflowTo;
  const cashflowPoolIdRef = useRef(cashflowPoolId);
  cashflowPoolIdRef.current = cashflowPoolId;
  const cashflowDirectionRef = useRef(cashflowDirection);
  cashflowDirectionRef.current = cashflowDirection;
  const cashflowLedgerTypeRef = useRef(cashflowLedgerType);
  cashflowLedgerTypeRef.current = cashflowLedgerType;
  const cashflowAttributeRef = useRef(cashflowAttribute);
  cashflowAttributeRef.current = cashflowAttribute;
  const cashflowCategoryRef = useRef(cashflowCategory);
  cashflowCategoryRef.current = cashflowCategory;
  const cashflowKeywordRef = useRef(cashflowKeyword);
  cashflowKeywordRef.current = cashflowKeyword;
  const cashflowListRequestRef = useRef(0);

  const fetchCashflows = useCallback(async () => {
    setCashflowsReady(false);
    setCashflowLoading(true);
    setCashflowError(null);
    const listRequestId = ++cashflowListRequestRef.current;
    try {
      const result = await cashflowsApi.list({
        occurred_from: cashflowFromRef.current || undefined,
        occurred_to: cashflowToRef.current || undefined,
        pool_id: cashflowPoolIdRef.current ?? undefined,
        direction: cashflowDirectionRef.current || undefined,
        ledger_type: cashflowLedgerTypeRef.current || undefined,
        accounting_attribute: cashflowAttributeRef.current || undefined,
        category: cashflowCategoryRef.current.trim() || undefined,
        keyword: cashflowKeywordRef.current.trim() || undefined,
        limit: 2000,
        offset: 0,
      });
      if (listRequestId !== cashflowListRequestRef.current) return;
      setCashflows(result.items);
      setCashflowTotal(result.total);
      setCashflowTotals({
        income: result.total_in ?? "0.00",
        expense: result.total_out ?? "0.00",
      });
      setCashflowsReady(true);
    } catch (err) {
      if (listRequestId === cashflowListRequestRef.current) setCashflowError(normalizeError(err));
    } finally {
      if (listRequestId === cashflowListRequestRef.current) setCashflowLoading(false);
    }
  }, []);

  const lastFilterRef = useRef<{ base: string; keyword: string } | null>(null);
  useEffect(() => {
    if (!active) {
      lastFilterRef.current = null;
      return;
    }
    const base = JSON.stringify([cashflowFrom, cashflowTo, cashflowPoolId, cashflowDirection, cashflowLedgerType, cashflowAttribute, cashflowCategory]);
    const previous = lastFilterRef.current;
    const keywordOnly = previous !== null && previous.base === base && previous.keyword !== cashflowKeyword;
    lastFilterRef.current = { base, keyword: cashflowKeyword };
    cashflowListRequestRef.current += 1;
    setCashflowsReady(false);
    setCashflowLoading(true);
    setCashflowError(null);
    const timer = window.setTimeout(() => {
      void fetchCashflows();
    }, keywordOnly ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      cashflowListRequestRef.current += 1;
    };
  }, [
    active,
    cashflowAttribute,
    cashflowCategory,
    cashflowDirection,
    cashflowFrom,
    cashflowLedgerType,
    cashflowKeyword,
    cashflowPoolId,
    cashflowTo,
    fetchCashflows,
  ]);

  const exportCashflows = async () => {
    setCashflowExporting(true);
    try {
      downloadBlob(
        await cashflowsApi.exportCsv({
          occurred_from: cashflowFromRef.current || undefined,
          occurred_to: cashflowToRef.current || undefined,
          pool_id: cashflowPoolIdRef.current ?? undefined,
          direction: cashflowDirectionRef.current || undefined,
          ledger_type: cashflowLedgerTypeRef.current || undefined,
          accounting_attribute: cashflowAttributeRef.current || undefined,
          category: cashflowCategoryRef.current.trim() || undefined,
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

  return {
    cashflows,
    cashflowTotal,
    cashflowTotals,
    cashflowsReady,
    cashflowLoading,
    cashflowError,
    cashflowKeyword,
    setCashflowKeyword,
    cashflowPoolId,
    setCashflowPoolId,
    cashflowDirection,
    setCashflowDirection,
    cashflowFrom,
    cashflowTo,
    cashflowLedgerType,
    setCashflowLedgerType,
    cashflowAttribute,
    setCashflowAttribute,
    cashflowCategory,
    setCashflowCategory,
    // 筛选选项用代码事实源（与后端枚举/新建流水表单同源），不用孤儿词典：
    // FUND_FLOW_ACCOUNTING_ATTRIBUTE 词典后端无种子代码，数据漂移（2026-11-18
    // 口径改版后与枚举差异更大），改走 ACCOUNTING_ATTRIBUTE_LABEL（15 项与枚举一一对应）。
    flowDirectionOptions: FLOW_DIRECTION_OPTIONS,
    flowAttributeOptions: Object.entries(ACCOUNTING_ATTRIBUTE_LABEL).map(
      ([value, label]) => ({ value, label }),
    ),
    fetchCashflows,
    exportCashflows,
    cashflowExporting,
  };
}
