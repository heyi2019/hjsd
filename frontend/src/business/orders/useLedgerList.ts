import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { ACCOUNT_STATUS_LABEL, today } from "../../shared/lib/format";
import { filterRetiredOrderTypeOptions } from "../../shared/lib/retiredProducts";
import { useOptionSet } from "../../shared/lib/optionSets";
import { useSession } from "../../shared/state/session";
import { appMessage } from "../../shared/ui/appFeedback";
import { useLatestRequest } from "../../shared/hooks/useLatestRequest";
import type { BusinessFilterKey, BusinessModeFilterKey } from "./helpers";

type Opt = { value: string; label: string };

export interface InitialLedgerFilters {
  status?: string;
  keyword?: string;
  tradeDateFrom?: string;
  tradeDateTo?: string;
}

/**
 * 订单台账列表：数据加载、筛选、分页、排序、导出与选项词典。
 */
export function useLedgerList(params: { active: boolean; initialMine: boolean; initialFilters?: InitialLedgerFilters }) {
  const { active, initialMine, initialFilters } = params;
  const { username } = useSession();
  const initialStatus = initialFilters?.status;
  const initialKeyword = initialFilters?.keyword;
  const initialTradeDateFrom = initialFilters?.tradeDateFrom;
  const initialTradeDateTo = initialFilters?.tradeDateTo;
  const [orders, setOrders] = useState<Order[]>([]);
  const [ledgerSummary, setLedgerSummary] = useState<Awaited<ReturnType<typeof ordersApi.ledgerSummary>> | null>(null);
  const [pageTotal, setPageTotal] = useState(0);
  const [gameTypes, setGameTypes] = useState<string[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<{ message: string; code?: string } | null>(null);
  const previousSummaryQuery = useRef<{ keyword: string | undefined; filters: string; revision: number } | null>(null);
  const previousListQuery = useRef<{ keyword: string | undefined; filters: string; revision: number } | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mineOrders, setMineOrders] = useState(initialMine);
  const requestSequence = useLatestRequest();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // 订单台账排序：默认最新在前，可切换最旧在前（仅调展示顺序，不动接口）。
  const [ledgerSortDesc, setLedgerSortDesc] = useState(true);
  const [ledgerExporting, setLedgerExporting] = useState(false);

  const exportLedger = async () => {
    setLedgerExporting(true);
    try {
      downloadBlob(await ordersApi.exportCsv(queryFilters), `订单台账-${today()}.csv`);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerExporting(false);
    }
  };
  /** 导出 Excel：5 个 sheet（主订单 + 详情 + 操作/资金/返点三类明细），表头为合并单元格。 */
  const exportLedgerXlsx = async () => {
    setLedgerExporting(true);
    try {
      downloadBlob(await ordersApi.exportXlsx(queryFilters), `订单台账-${today()}.xlsx`);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerExporting(false);
    }
  };

  const [orderTypeFilter, setOrderTypeFilter] = useState<BusinessFilterKey>("all");
  const [orderStatusFilter, setOrderStatusFilter] = useState(initialStatus ?? "all");
  const [businessModeFilter, setBusinessModeFilter] = useState<BusinessModeFilterKey>("all");
  const [gameTypeFilter, setGameTypeFilter] = useState("all");
  const [inventoryStatusFilter, setInventoryStatusFilter] = useState("all");
  const [inventoryOperatorIds, setInventoryOperatorIds] = useState<number[]>([]);
  const [saleOperatorIds, setSaleOperatorIds] = useState<number[]>([]);
  const [myOperatorId, setMyOperatorId] = useState<number | undefined>();
  const [myOperator, setMyOperator] = useState<{ id: number; display_name: string } | undefined>();
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(() => (
    initialTradeDateFrom && initialTradeDateTo
      ? [dayjs(initialTradeDateFrom), dayjs(initialTradeDateTo)]
      : null
  ));
  // 业务类型、业务模式、责任方和关联关系均来自后端选项词典。
  const orderBusinessOptions: Opt[] = filterRetiredOrderTypeOptions(useOptionSet("ORDER_BUSINESS") ?? []);
  const orderBusinessModeOptions: Opt[] = useOptionSet("ORDER_BUSINESS_MODE") ?? [];
  const inventoryStatusOptions: Opt[] = [
    { value: "all", label: "全部库存状态" },
    ...(["WAITING", "SOLD", "VOID"] as const).map((value) => ({ value, label: ACCOUNT_STATUS_LABEL[value] })),
  ];
  const gameTypeOptions = useMemo(
    () => [{ value: "all", label: "全部游戏类型" }, ...gameTypes.map((value) => ({ value, label: value }))],
    [gameTypes],
  );
  const [keyword, setKeyword] = useState(initialKeyword ?? "");
  const [searchRevision, setSearchRevision] = useState(0);
  const submitSearch = () => setSearchRevision((value) => value + 1);

  const queryFilters = useMemo(() => ({
    mine: mineOrders,
    ...(orderTypeFilter !== "all" ? { order_type: orderTypeFilter } : {}),
    ...(orderStatusFilter !== "all" ? { status: orderStatusFilter } : {}),
    ...(businessModeFilter !== "all" ? { business_mode: businessModeFilter } : {}),
    ...(gameTypeFilter !== "all" ? { game_type: gameTypeFilter } : {}),
    ...(inventoryStatusFilter !== "all" ? { account_status: inventoryStatusFilter } : {}),
    ...(!mineOrders && inventoryOperatorIds.length ? { inventory_operator_ids: inventoryOperatorIds } : {}),
    ...(!mineOrders && saleOperatorIds.length ? { sale_operator_ids: saleOperatorIds } : {}),
    ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
    ...(dateRange ? {
      trade_date_from: dateRange[0].format("YYYY-MM-DD"),
      trade_date_to: dateRange[1].format("YYYY-MM-DD"),
    } : {}),
  }), [mineOrders, orderTypeFilter, orderStatusFilter, businessModeFilter, gameTypeFilter, inventoryStatusFilter, inventoryOperatorIds, saleOperatorIds, keyword, dateRange]);

  const load = useCallback(async () => {
    const requestId = requestSequence.start();
    setLoading(true);
    try {
      const result = await ordersApi.listPage({
        ...queryFilters,
        sort_desc: ledgerSortDesc,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      if (!requestSequence.isCurrent(requestId)) return;
      setOrders(result.items);
      setPageTotal(result.total);
      setLoadError(null);
    } catch (error) {
      if (requestSequence.isCurrent(requestId)) setLoadError(normalizeError(error));
    } finally {
      if (requestSequence.isCurrent(requestId)) setLoading(false);
    }
  }, [queryFilters, ledgerSortDesc, page, pageSize, requestSequence]);

  const initialQueryKey = JSON.stringify([initialMine, initialStatus, initialTradeDateFrom, initialTradeDateTo, initialKeyword, myOperatorId]);
  const [initializedQueryKey, setInitializedQueryKey] = useState<string | null>(null);
  useEffect(() => {
    if (active) {
      setMineOrders(initialMine);
      setOrderStatusFilter(initialStatus ?? "all");
      if (initialKeyword !== undefined) {
        setKeyword(initialKeyword);
        setOrderTypeFilter("all");
        setBusinessModeFilter("all");
        setGameTypeFilter("all");
        setInventoryStatusFilter("all");
      }
      setDateRange((previous) => {
        if (previous?.[0].format("YYYY-MM-DD") === initialTradeDateFrom && previous?.[1].format("YYYY-MM-DD") === initialTradeDateTo) return previous;
        return initialTradeDateFrom && initialTradeDateTo ? [dayjs(initialTradeDateFrom), dayjs(initialTradeDateTo)] : null;
      });
      const mineOperatorIds = initialMine && myOperatorId !== undefined ? [myOperatorId] : [];
      setInventoryOperatorIds((previous) => previous.length === mineOperatorIds.length && previous.every((id, index) => id === mineOperatorIds[index]) ? previous : mineOperatorIds);
      setSaleOperatorIds((previous) => previous.length === mineOperatorIds.length && previous.every((id, index) => id === mineOperatorIds[index]) ? previous : mineOperatorIds);
      setPage(1);
      setInitializedQueryKey(initialQueryKey);
    } else setInitializedQueryKey(null);
  }, [active, initialMine, initialStatus, initialTradeDateFrom, initialTradeDateTo, initialKeyword, myOperatorId, initialQueryKey]);

  useEffect(() => {
    if (!active || !initialMine) {
      setMyOperatorId(undefined);
      setMyOperator(undefined);
      return;
    }
    let cancelled = false;
    void employeesApi.list().then((employees) => {
      if (cancelled) return;
      const employee = employees.find((item) => item.is_active && item.username === username);
      setMyOperatorId(employee?.id);
      setMyOperator(employee ? { id: employee.id, display_name: employee.display_name } : undefined);
    }).catch(() => {
      if (!cancelled) {
        setMyOperatorId(undefined);
        setMyOperator(undefined);
      }
    });
    return () => { cancelled = true; };
  }, [active, initialMine, username]);

  // keep-alive 重新激活、筛选变更、翻页或排序变更时均由后端返回当前页。
  useEffect(() => {
    if (!active || initializedQueryKey !== initialQueryKey) {
      previousListQuery.current = null;
      return requestSequence.invalidate;
    }
    const { keyword: searchKeyword, ...otherFilters } = queryFilters;
    const filters = JSON.stringify(otherFilters);
    const previous = previousListQuery.current;
    const debounceSearch = previous !== null && previous.revision === searchRevision && previous.filters === filters && previous.keyword !== searchKeyword;
    previousListQuery.current = { keyword: searchKeyword, filters, revision: searchRevision };
    if (debounceSearch) setLoading(true);
    const timer = debounceSearch ? window.setTimeout(() => void load(), 250) : undefined;
    if (!debounceSearch) void load();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      requestSequence.invalidate();
    };
  }, [active, initializedQueryKey, initialQueryKey, load, queryFilters, requestSequence, searchRevision]);

  useEffect(() => {
    if (!active || initializedQueryKey !== initialQueryKey) {
      previousSummaryQuery.current = null;
      return;
    }
    let cancelled = false;
    setSummaryLoading(true);
    setLedgerSummary(null);
    const { keyword: searchKeyword, ...otherFilters } = queryFilters;
    const filters = JSON.stringify(otherFilters);
    const previous = previousSummaryQuery.current;
    const debounceSearch = previous !== null && previous.revision === searchRevision && previous.filters === filters && previous.keyword !== searchKeyword;
    previousSummaryQuery.current = { keyword: searchKeyword, filters, revision: searchRevision };
    const fetchSummary = () => {
      void ordersApi.ledgerSummary(queryFilters).then((result) => {
        if (cancelled) return;
        setLedgerSummary(result);
        setGameTypes(result.game_types);
        setSummaryError(null);
      }).catch((error) => {
        if (cancelled) return;
        setSummaryError(normalizeError(error));
      }).finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    };
    const timer = debounceSearch ? window.setTimeout(fetchSummary, 250) : undefined;
    if (!debounceSearch) fetchSummary();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, initializedQueryKey, initialQueryKey, queryFilters, searchRevision]);

  const filteredOrders = orders;

  return {
    orders,
    ledgerSummary,
    pageTotal,
    summaryLoading,
    summaryError,
    setOrders,
    loadError,
    loading,
    page,
    setPage,
    pageSize,
    setPageSize,
    ledgerSortDesc,
    setLedgerSortDesc,
    ledgerExporting,
    setMineOrders,
    exportLedger,
    exportLedgerXlsx,
    orderTypeFilter,
    setOrderTypeFilter,
    orderStatusFilter,
    setOrderStatusFilter,
    businessModeFilter,
    setBusinessModeFilter,
    gameTypeFilter,
    setGameTypeFilter,
    inventoryStatusFilter,
    setInventoryStatusFilter,
    inventoryOperatorIds,
    setInventoryOperatorIds,
    saleOperatorIds,
    setSaleOperatorIds,
    myOperator,
    dateRange,
    setDateRange,
    keyword,
    setKeyword,
    submitSearch,
    orderBusinessOptions,
    orderBusinessModeOptions,
    inventoryStatusOptions,
    gameTypeOptions,
    filteredOrders,
    load,
  };
}
