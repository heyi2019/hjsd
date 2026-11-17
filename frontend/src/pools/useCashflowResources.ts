import { useCallback, useEffect, useRef, useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { cashflowsApi } from "../shared/api/cashflows.api";
import type { Cashflow } from "../shared/api/types/finance";
import { normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { today } from "../shared/lib/format";
import { useOptionSet } from "../shared/lib/optionSets";

/** 资金流水查询域：筛选、服务端汇总、导出和列表状态集中在这里。 */
export function useCashflowResources(active = true) {
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [cashflowTotal, setCashflowTotal] = useState(0);
  const [cashflowTotals, setCashflowTotals] = useState({ income: "0.00", expense: "0.00" });
  const [cashflowsReady, setCashflowsReady] = useState(false);
  const [cashflowKeyword, setCashflowKeyword] = useState("");
  const [cashflowPoolId, setCashflowPoolId] = useState<number | undefined>();
  const [cashflowDirection, setCashflowDirection] = useState<string | undefined>();
  const [cashflowFrom, setCashflowFrom] = useState("");
  const [cashflowTo, setCashflowTo] = useState("");
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
  const cashflowTotalsRequestRef = useRef(0);

  const fetchCashflows = useCallback(async () => {
    setCashflowsReady(false);
    const totalsRequestId = ++cashflowTotalsRequestRef.current;
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
    setCashflows(result.items);
    setCashflowTotal(result.total);
    if (totalsRequestId === cashflowTotalsRequestRef.current) {
      setCashflowTotals({
        income: result.total_in ?? "0.00",
        expense: result.total_out ?? "0.00",
      });
    }
    setCashflowsReady(true);
  }, []);

  useEffect(() => {
    if (!active) return;
    const requestId = ++cashflowTotalsRequestRef.current;
    const timer = window.setTimeout(() => {
      void cashflowsApi.totals({
        occurred_from: cashflowFrom || undefined,
        occurred_to: cashflowTo || undefined,
        pool_id: cashflowPoolId,
        direction: cashflowDirection || undefined,
        ledger_type: cashflowLedgerType || undefined,
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
    cashflowLedgerType,
    cashflowKeyword,
    cashflowPoolId,
    cashflowTo,
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
    cashflowKeyword,
    setCashflowKeyword,
    cashflowPoolId,
    setCashflowPoolId,
    cashflowDirection,
    setCashflowDirection,
    cashflowFrom,
    setCashflowFrom,
    cashflowTo,
    setCashflowTo,
    cashflowLedgerType,
    setCashflowLedgerType,
    cashflowAttribute,
    setCashflowAttribute,
    cashflowCategory,
    setCashflowCategory,
    flowDirectionOptions: useOptionSet("FUND_FLOW_DIRECTION"),
    flowAttributeOptions: useOptionSet("FUND_FLOW_ACCOUNTING_ATTRIBUTE"),
    fetchCashflows,
    exportCashflows,
    cashflowExporting,
  };
}
