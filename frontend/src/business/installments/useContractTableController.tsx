import { useCallback, useEffect, useRef, useState } from "react";
import { installmentsApi } from "../../shared/api/installments.api";
import type { Installment, InstallmentTotals } from "../../shared/api/types/installments";
import { normalizeError } from "../../shared/api/client";
import { useEmployeeOptions } from "../../shared/hooks/useEmployeeOptions";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { useSession } from "../../shared/state/session";
import type { Permission } from "../../shared/state/session";
import { useContractActions } from "./useContractActions";
import { useContractModalState } from "./useContractModalState";
import { buildContractColumns } from "./contractColumns";

export function useContractTableController(params: { contractType: string; reloadKey: number; active?: boolean; dateRange?: [string, string] | null; status?: string }) {
  const { contractType, reloadKey, active = true, dateRange, status } = params;
  // 上层每次渲染都会新建 [from, to] 数组，直接当 useCallback 依赖会每次变化 →
  // load 变 → useEffect 触发 → 无限重拉。这里只依赖两个原始字符串。
  const dateFrom = dateRange?.[0] ?? "";
  const dateTo = dateRange?.[1] ?? "";
  const [rows, setRows] = useState<Installment[]>([]);
  const [totals, setTotals] = useState<InstallmentTotals | null>(null);
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [pageTotal, setPageTotal] = useState(0);
  const { activeEmployees: employees, error: employeeError, settled: employeesSettled, reloadFresh: reloadEmployees } = useEmployeeOptions();
  const { can } = useSession();
  // 提前结清：后端接受 order.event.post 或 finance.order.event.post 任一，取当前用户实际持有的码做门控。
  const settlePermission: Permission = can("order.event.post") ? "order.event.post" : "finance.order.event.post";
  const modal = useContractModalState(active);
  const {
    payTarget, deliverTarget, recoverTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    setPayTarget, setDeliverTarget, setRecoverTarget, setCancelTarget, setSettleTarget, setDefaultTarget, setWaiveTarget, setExtendTarget,
    payForm, deliverForm, recoverForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm, write,
  } = modal;
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [listError, setListError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [totalsLoading, setTotalsLoading] = useState(true);
  const [totalsError, setTotalsError] = useState<{ message: string; code?: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  // 筛选条件/reloadKey 变化会重新触发 load；用请求序号丢弃过期响应，避免旧请求
  // 后到覆盖新筛选的列表与合计（与 useLedgerList 同一范式）。
  const listSeqRef = useRef(0);
  const totalsSeqRef = useRef(0);
  const loadList = useCallback(async () => {
    const seq = ++listSeqRef.current;
    setLoading(true);
    const rangeParams = {
      contract_type: contractType,
      status: status || undefined,
      trade_date_from: dateFrom || undefined,
      trade_date_to: dateTo || undefined,
    };
    await installmentsApi.page({ ...rangeParams, limit: pageSize, offset: (page - 1) * pageSize, sort_desc: sortDesc })
        .then((result) => {
          if (seq !== listSeqRef.current) return;
          const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
          if (page > lastPage) {
            setPage(lastPage);
            return;
          }
          setRows(result.items);
          setPageTotal(result.total);
          setListError(false);
          setError(null);
        })
        .catch((err) => { if (seq === listSeqRef.current) { setRows([]); setPageTotal(0); setListError(true); setError(normalizeError(err)); } })
        .finally(() => { if (seq === listSeqRef.current) setLoading(false); });
  }, [contractType, dateFrom, dateTo, status, page, pageSize, sortDesc]);

  const loadTotals = useCallback(async () => {
    const seq = ++totalsSeqRef.current;
    setTotalsLoading(true);
    setTotalsError(null);
    const rangeParams = {
      contract_type: contractType,
      status: status || undefined,
      trade_date_from: dateFrom || undefined,
      trade_date_to: dateTo || undefined,
    };
    await installmentsApi.totals(rangeParams)
      .then((summary) => { if (seq === totalsSeqRef.current) setTotals(summary); })
      .catch((err) => { if (seq === totalsSeqRef.current) setTotalsError(normalizeError(err)); })
      .finally(() => { if (seq === totalsSeqRef.current) setTotalsLoading(false); });
  }, [contractType, dateFrom, dateTo, status]);

  const load = useCallback(async () => {
    await Promise.all([loadList(), loadTotals()]);
  }, [loadList, loadTotals]);
  const latestLoadRef = useRef({ active, load });
  latestLoadRef.current = { active, load };
  const reloadAfterAction = useCallback(async () => {
    const current = latestLoadRef.current;
    if (current.active) await current.load();
  }, []);

  const resetKey = JSON.stringify([contractType, dateFrom, dateTo, status, sortDesc]);
  const previousResetKey = useRef(resetKey);
  useEffect(() => {
    if (!active) return;
    if (previousResetKey.current !== resetKey) {
      previousResetKey.current = resetKey;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    void loadList();
    return () => { listSeqRef.current += 1; };
  }, [active, loadList, page, reloadKey, resetKey]);
  useEffect(() => {
    if (!active) return;
    void loadTotals();
    return () => { totalsSeqRef.current += 1; };
  }, [active, loadTotals, reloadKey]);

  const {
    exportCsv, submitPay, submitDeliver, openDeliver, submitRecover,
    submitCancel, submitSettleEarly, submitDefault, submitWaive,
    submitExtend, updateOperationOperators, isOperatorUpdating,
  } = useContractActions({
    modal,
    load: reloadAfterAction, setExporting,
    filters: { contract_type: contractType, status: status || undefined, trade_date_from: dateFrom || undefined, trade_date_to: dateTo || undefined },
  });

  // 总应收 / 剩余应收都只采用后端下发值（含「不小于 0」的 clamp），前端不再自行推导。
  const totalReceivable = totals?.total_receivable ?? "0.00";
  const totalPaid = totals?.total_paid ?? "0.00";
  const overdueCount = totals?.overdue_count ?? 0;

  const { arrange: arrangeColumns } = useListViewColumns("INSTALLMENT");
  const { columns, scheduleColumns } = buildContractColumns({
    payForm, recoverForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm,
    setPayTarget, setRecoverTarget, setCancelTarget, setSettleTarget, setDefaultTarget,
    setWaiveTarget, setExtendTarget, openDeliver, settlePermission,
  });

  return {
    rows,
    setRows,
    sortDesc,
    setSortDesc,
    page,
    setPage,
    pageSize,
    setPageSize,
    pageTotal,
    can,
    settlePermission,
    payTarget,
    setPayTarget,
    deliverTarget,
    setDeliverTarget,
    recoverTarget,
    setRecoverTarget,
    cancelTarget,
    setCancelTarget,
    settleTarget,
    setSettleTarget,
    defaultTarget,
    setDefaultTarget,
    waiveTarget,
    setWaiveTarget,
    extendTarget,
    setExtendTarget,
    error,
    listError,
    setError,
    loading,
    totalsLoading,
    totalsError,
    setLoading,
    write,
    payForm,
    deliverForm,
    recoverForm,
    cancelForm,
    settleForm,
    defaultForm,
    waiveForm,
    extendForm,
    load,
    exporting,
    setExporting,
    exportCsv,
    submitPay,
    submitDeliver,
    openDeliver,
    submitRecover,
    submitCancel,
    submitSettleEarly,
    submitDefault,
    submitWaive,
    submitExtend,
    updateOperationOperators,
    isOperatorUpdating,
    totalReceivable,
    totalPaid,
    totalCount: totals?.total_count ?? 0,
    overdueCount,
    employees,
    employeeError: employeeError ? normalizeError(employeeError) : null,
    employeesSettled,
    reloadEmployees,
    arrangeColumns,
    columns,
    scheduleColumns,
  };
}

export type ContractTableController = ReturnType<typeof useContractTableController>;
