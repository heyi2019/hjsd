import { appMessage } from "../../shared/ui/appFeedback";
import { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { stocksApi } from "../../shared/api/stocks.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account, InventoryStats } from "../../shared/api/types/accounts";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { downloadInventoryCsv } from "../inventory-export";
import { useOptionSet } from "../../shared/lib/optionSets";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";
import { filterInventoryRows } from "./helpers";
import { inventoryTypeOfOrder, mergeInventoryAccount, type InventoryOrderRow } from "./types";

function findInventoryOrder(account: Account, candidates: Order[]): Order | null {
  const bySourceId = account.source_order_id == null
    ? undefined
    : candidates.find((order) => order.id === account.source_order_id);
  if (bySourceId) return bySourceId;

  const byStockNo = account.stock_no
    ? candidates.filter((order) => order.stock_no === account.stock_no)
    : [];
  if (byStockNo.length === 1) return byStockNo[0];

  // 只有账号与一张待售订单存在明确的一对一关系时才允许回落；
  // 同账号多单且没有来源键时宁可不展示，也不能把库存编号错挂到第一张订单。
  return candidates.length === 1 ? candidates[0] : null;
}

function toInventoryOrderRows(accounts: Account[], orders: Order[]): InventoryOrderRow[] {
  const ordersByAccount = new Map<number, Order[]>();
  for (const order of orders) {
    if (order.account_id != null && order.account_status === "WAITING") {
      const current = ordersByAccount.get(order.account_id) ?? [];
      current.push(order);
      ordersByAccount.set(order.account_id, current);
    }
  }
  return accounts
    .filter((account) => account.status === "WAITING")
    .flatMap((account) => {
      const candidates = ordersByAccount.get(account.id) ?? [];
      const order = findInventoryOrder(account, candidates);
      if (!order) return [];
      return [mergeInventoryAccount({
        ...order,
        account,
        inventory_type: inventoryTypeOfOrder(order, account),
      }, account)];
    });
}

export function useInventoryList({ active = true, refreshKey = 0 }: { active?: boolean; refreshKey?: number }) {
const INVENTORY_STATS_DEBOUNCE_MS = 200;
  const [rows, setRows] = useState<InventoryOrderRow[]>([]);
  const [inventoryStats, setInventoryStats] = useState<InventoryStats | null>(null);
  const [businessMode, setBusinessMode] = useState<string | undefined>(undefined);
  const [inventoryType, setInventoryType] = useState<string | undefined>(undefined);
  const [gameTypeFilter, setGameTypeFilter] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState("");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [sortDesc, setSortDesc] = useState(true);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [exporting, setExporting] = useState(false);
  const locallyRemovedIdsRef = useRef(new Set<number>());
  // T20：筛选项从「选项词典」配置读取（库存业务 / 类型）。
  const businessOptions = useOptionSet("INVENTORY_BUSINESS");
  const inventoryTypeOptions = useOptionSet("INVENTORY_TYPE");
  const gameTypeOptions = Array.from(new Set((rows ?? [])
    .map((row) => row.account_game_type)
    .filter((value): value is string => Boolean(value))))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((value) => ({ value, label: value }));
  const load = useCallback(async () => {
    try {
      const [accountList, orderList] = await Promise.all([
        stocksApi.list({ status: "WAITING" }),
        ordersApi.list(),
      ]);
      const list = toInventoryOrderRows(accountList ?? [], orderList ?? []);
      const freshIds = new Set(list.map((row) => row.account.id));
      locallyRemovedIdsRef.current.forEach((id) => {
        if (!freshIds.has(id)) locallyRemovedIdsRef.current.delete(id);
      });
      setRows(list.filter((row) => !locallyRemovedIdsRef.current.has(row.account.id)));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);
  useReloadOnActive(active, load);
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === previousRefreshKey.current) return;
    previousRefreshKey.current = refreshKey;
    setPage(1);
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (refreshKey > 0) setPage(1);
  }, [refreshKey]);
  const inventoryRows = filterInventoryRows(rows ?? [], { businessMode, gameType: gameTypeFilter });
  const countInventoryRows = (type?: string) => inventoryRows.filter((row) => !type || row.inventory_type === type).length;
  const visibleRows = useMemo(() => filterInventoryRows(rows ?? [], {
    businessMode,
    inventoryType,
    gameType: gameTypeFilter,
    keyword,
    dateRange,
  }), [rows, businessMode, inventoryType, gameTypeFilter, keyword, dateRange]);
  // 展示排序：默认最新在前，可切换最旧在前（统计口径不受影响）。
  const orderedRows = [...visibleRows].sort((a, b) => (sortDesc ? b.id - a.id : a.id - b.id));
  // 卡片上的金额与库龄档位由后端按「当前可见集合」汇总：筛选只在前端做一份，
  // 算术只在后端做一份，避免 Number() 累加的浮点残渣与两套日期口径漂移。
  useEffect(() => {
    const accountIds = visibleRows.map((row) => row.account.id);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      stocksApi.inventoryStats(accountIds)
        .then((data) => {
          if (!cancelled && data) setInventoryStats(data);
        })
        // 指标是派生展示值，取不到就保留上一次结果，不打断台账主流程。
        .catch(() => undefined);
    }, INVENTORY_STATS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [visibleRows]);
  async function handleExport() {
    setExporting(true);
    try {
      const detailResults = await Promise.all(visibleRows.map(async (row) => {
        try {
          return [row.account.id, await stocksApi.executionDetail(row.account.id)] as const;
        } catch {
          return [row.account.id, undefined] as const;
        }
      }));
      const details = Object.fromEntries(detailResults) as Partial<Record<number, AccountExecutionDetail>>;
      const failedCount = detailResults.filter(([, detail]) => !detail).length;
      downloadInventoryCsv(visibleRows.map((row) => row.account), details);
      if (failedCount) {
        appMessage.warning(`${failedCount} 条明细读取失败，已导出其余可用字段`);
      } else {
        appMessage.success("库存 CSV 已导出");
      }
    } finally {
      setExporting(false);
    }
  }

  return {
    rows,
    setRows,
    inventoryStats,
    businessMode,
    setBusinessMode,
    inventoryType,
    setInventoryType,
    gameTypeFilter,
    setGameTypeFilter,
    keyword,
    setKeyword,
    dateRange,
    setDateRange,
    sortDesc,
    setSortDesc,
    page,
    setPage,
    pageSize,
    setPageSize,
    error,
    setError,
    businessOptions,
    inventoryTypeOptions,
    gameTypeOptions,
    load,
    countInventoryRows,
    visibleRows,
    orderedRows,
    handleExport,
    exporting,
    locallyRemovedIdsRef,
  };
}
