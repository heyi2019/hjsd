import { Form } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { installmentsApi } from "../../shared/api/installments.api";
import type { Installment, InstallmentTotals, Schedule } from "../../shared/api/types/installments";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { useEmployeeOptions } from "../../shared/hooks/useEmployeeOptions";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { useSession } from "../../shared/state/session";
import type { Permission } from "../../shared/state/session";
import { useContractActions } from "./useContractActions";
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
  const [resaleOrders, setResaleOrders] = useState<Order[]>([]);
  const { activeEmployees: employees, error: employeeError } = useEmployeeOptions();
  const { can } = useSession();
  // 提前结清：后端接受 order.event.post 或 finance.order.event.post 任一，取当前用户实际持有的码做门控。
  const settlePermission: Permission = can("order.event.post") ? "order.event.post" : "finance.order.event.post";
  const [payTarget, setPayTarget] = useState<Installment | null>(null);
  const [deliverTarget, setDeliverTarget] = useState<Installment | null>(null);
  const [recoverTarget, setRecoverTarget] = useState<Installment | null>(null);
  const [resaleTarget, setResaleTarget] = useState<Installment | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Installment | null>(null);
  const [settleTarget, setSettleTarget] = useState<Installment | null>(null);
  const [defaultTarget, setDefaultTarget] = useState<Installment | null>(null);
  const [waiveTarget, setWaiveTarget] = useState<Schedule | null>(null);
  const [extendTarget, setExtendTarget] = useState<Schedule | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [totalsLoading, setTotalsLoading] = useState(true);
  const [totalsError, setTotalsError] = useState<{ message: string; code?: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();

  // P2-274：各业务弹窗共享同一份 write.error，上一操作的失败提示会残留到其它弹窗。
  // 只要「某个业务弹窗由关到开」（含从 A 弹窗切到 B 弹窗）就清空错误态，保证每个弹窗起始干净。
  // 注意：不能把 write 放进依赖——useAsyncAction 每次渲染返回新对象，一旦放入，失败提示被
  // setError 写出后，同一次重渲染就会再次触发 effect 把 error 清掉，反而吞掉失败提示
  // （回归测试 收款提交失败 / P2-274 会因此失败）。write.clearError 本身是稳定引用，可安全调用。
  const prevTargetsRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    const targets: Record<string, unknown> = {
      payTarget, deliverTarget, recoverTarget, resaleTarget,
      cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    };
    const openedNew = Object.keys(targets).some((k) => targets[k] && !prevTargetsRef.current[k]);
    if (openedNew) write.clearError();
    prevTargetsRef.current = targets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payTarget, deliverTarget, recoverTarget, resaleTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget]);
  const [payForm] = Form.useForm();
  const [deliverForm] = Form.useForm();
  const [recoverForm] = Form.useForm();
  const [resaleForm] = Form.useForm();
  const [cancelForm] = Form.useForm();
  const [settleForm] = Form.useForm();
  const [defaultForm] = Form.useForm();
  const [waiveForm] = Form.useForm();
  const [extendForm] = Form.useForm();

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
          setError(null);
        })
        .catch((err) => { if (seq === listSeqRef.current) setError(normalizeError(err)); })
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

  // 写操作已提取到 useContractActions（函数体一字未改）：传入 state/form/setter
  // 与共享的 write/load，保持原闭包语义；返回字段与原 controller 完全一致。
  const {
    exportCsv, submitPay, submitDeliver, openDeliver, submitRecover, submitResale,
    openResale, submitCancel, submitSettleEarly, submitDefault, submitWaive,
    submitExtend, updateOperationOperators,
  } = useContractActions({
    payTarget, deliverTarget, recoverTarget, resaleTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    setPayTarget, setDeliverTarget, setRecoverTarget, setResaleTarget, setCancelTarget, setSettleTarget, setDefaultTarget, setWaiveTarget, setExtendTarget,
    payForm, deliverForm, recoverForm, resaleForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm,
    write, load, setError, setResaleOrders, setExporting,
    filters: { contract_type: contractType, status: status || undefined, trade_date_from: dateFrom || undefined, trade_date_to: dateTo || undefined },
  });

  useEffect(() => {
    if (employeeError) setError(normalizeError(employeeError));
  }, [employeeError]);

  // 总应收 / 剩余应收都只采用后端下发值（含「不小于 0」的 clamp），前端不再自行推导。
  const totalReceivable = totals?.total_receivable ?? "0.00";
  const totalPaid = totals?.total_paid ?? "0.00";
  const overdueCount = totals?.overdue_count ?? 0;

  const { arrange: arrangeColumns } = useListViewColumns("INSTALLMENT");
  // 表格列定义是纯渲染配置，逐字提取到 contractColumns 工厂；依赖由本 controller 注入。
  const { columns, scheduleColumns } = buildContractColumns({
    payForm, recoverForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm,
    setPayTarget, setRecoverTarget, setCancelTarget, setSettleTarget, setDefaultTarget,
    setWaiveTarget, setExtendTarget, openDeliver, openResale, settlePermission,
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
    resaleTarget,
    setResaleTarget,
    resaleOrders,
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
    setError,
    loading,
    totalsLoading,
    totalsError,
    setLoading,
    write,
    payForm,
    deliverForm,
    recoverForm,
    resaleForm,
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
    submitResale,
    submitCancel,
    submitSettleEarly,
    submitDefault,
    submitWaive,
    submitExtend,
    updateOperationOperators,
    totalReceivable,
    totalPaid,
    totalCount: totals?.total_count ?? 0,
    overdueCount,
    employees,
    arrangeColumns,
    columns,
    scheduleColumns,
  };
}

export type ContractTableController = ReturnType<typeof useContractTableController>;
