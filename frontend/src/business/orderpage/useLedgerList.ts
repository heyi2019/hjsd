import { useCallback, useEffect, useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { orderTypesApi, ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import type { Order, OrderType } from "../../shared/api/types/orders";
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
  tradeDateFrom?: string;
  tradeDateTo?: string;
}

/**
 * 订单台账「列表域」：数据加载、筛选、分页、排序、导出与选项词典，以及派生的 filteredOrders。
 * 从 useOrdersPageController 拆出，保持纯参数入 / 扁平返回出，不持有任何 modal / 账号动作状态。
 * 这样主 hook 只保留跨域共享枢纽（selectedOrder / actionOrder / users / loadLedgerDetail）与动作编排。
 */
export function useLedgerList(params: { active: boolean; initialMine: boolean; initialFilters?: InitialLedgerFilters }) {
  const { active, initialMine, initialFilters } = params;
  const { username } = useSession();
  const initialStatus = initialFilters?.status;
  const initialTradeDateFrom = initialFilters?.tradeDateFrom;
  const initialTradeDateTo = initialFilters?.tradeDateTo;
  const [orders, setOrders] = useState<Order[]>([]);
  const [ledgerSummary, setLedgerSummary] = useState<Awaited<ReturnType<typeof ordersApi.ledgerSummary>> | null>(null);
  const [pageTotal, setPageTotal] = useState(0);
  const [gameTypes, setGameTypes] = useState<string[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<{ message: string; code?: string } | null>(null);
  const [types, setTypes] = useState<OrderType[]>([]);
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
      // 导出必须与当前视图同口径：「我的订单」视图只导出我负责的单，不借导出绕过筛选拿全量。
      downloadBlob(await ordersApi.exportCsv({ mine: mineOrders }), `订单台账-${today()}.csv`);
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
      downloadBlob(await ordersApi.exportXlsx({ mine: mineOrders }), `订单台账-${today()}.xlsx`);
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
  const [keyword, setKeyword] = useState("");

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

  useEffect(() => {
    if (active) {
      setMineOrders(initialMine);
      setOrderStatusFilter(initialStatus ?? "all");
      setDateRange(initialTradeDateFrom && initialTradeDateTo ? [dayjs(initialTradeDateFrom), dayjs(initialTradeDateTo)] : null);
      const mineOperatorIds = initialMine && myOperatorId !== undefined ? [myOperatorId] : [];
      setInventoryOperatorIds(mineOperatorIds);
      setSaleOperatorIds(mineOperatorIds);
      setPage(1);
    }
  }, [active, initialMine, initialStatus, initialTradeDateFrom, initialTradeDateTo, myOperatorId]);

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

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void orderTypesApi.list().then((result) => {
      if (!cancelled) setTypes(result);
    }).catch((error) => {
      if (!cancelled) setLoadError(normalizeError(error));
    });
    return () => { cancelled = true; };
  }, [active, setLoadError]);

  // keep-alive 重新激活、筛选变更、翻页或排序变更时均由后端返回当前页。
  useEffect(() => {
    if (active) void load();
    return requestSequence.invalidate;
  }, [active, load, requestSequence]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setSummaryLoading(true);
    setLedgerSummary(null);
    const timer = window.setTimeout(() => {
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
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, queryFilters]);

  const typeNames = useMemo(() => Object.fromEntries(types.map((type) => [type.code, type.name])), [types]);
  const filteredOrders = orders;

  return {
    orders,
    ledgerSummary,
    pageTotal,
    summaryLoading,
    summaryError,
    setOrders,
    types,
    setTypes,
    loadError,
    setLoadError,
    loading,
    setLoading,
    page,
    setPage,
    pageSize,
    setPageSize,
    ledgerSortDesc,
    setLedgerSortDesc,
    ledgerExporting,
    setLedgerExporting,
    mineOrders,
    setMineOrders,
    exportLedger,
    exportLedgerXlsx,
    orderTypeFilter,
    setOrderTypeFilter,
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
    orderBusinessOptions,
    orderBusinessModeOptions,
    inventoryStatusOptions,
    gameTypeOptions,
    typeNames,
    filteredOrders,
    load,
  };
}
