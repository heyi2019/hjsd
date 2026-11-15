import { appMessage } from "../../shared/ui/appFeedback";
import { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { stocksApi } from "../../shared/api/stocks.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { InventoryStats } from "../../shared/api/types/accounts";
import { normalizeError } from "../../shared/api/client";
import { downloadInventoryCsv } from "../inventory-export";
import { useOptionSet } from "../../shared/lib/optionSets";
import { inventoryTypeOfOrder, mergeInventoryAccount, type InventoryOrderRow } from "./types";

const PAGE_SIZE_MAX = 500;

function toInventoryOrderRow(account: InventoryOrderRow["account"], order: InventoryOrderRow): InventoryOrderRow {
  return mergeInventoryAccount({
    ...order,
    account,
    inventory_type: inventoryTypeOfOrder(order, account),
  }, account);
}

export function useInventoryList({ active = true, refreshKey = 0 }: { active?: boolean; refreshKey?: number }) {
  const [rows, setRows] = useState<InventoryOrderRow[]>([]);
  const [inventoryStats, setInventoryStats] = useState<InventoryStats | null>(null);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [totalCount, setTotalCount] = useState(0);
  const [facetTotal, setFacetTotal] = useState(0);
  const [businessMode, setBusinessMode] = useState<string | undefined>();
  const [inventoryType, setInventoryType] = useState<string | undefined>();
  const [gameTypeFilter, setGameTypeFilter] = useState<string | undefined>();
  const [keyword, setKeyword] = useState("");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [sortDesc, setSortDesc] = useState(true);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [exporting, setExporting] = useState(false);
  const [serverGameTypes, setServerGameTypes] = useState<string[]>([]);
  const locallyRemovedIdsRef = useRef(new Set<number>());
  const businessOptions = useOptionSet("INVENTORY_BUSINESS");
  const inventoryTypeOptions = useOptionSet("INVENTORY_TYPE");
  const gameTypeOptions = useMemo(() => serverGameTypes.map((value) => ({ value, label: value })), [serverGameTypes]);

  const filters = useMemo(() => ({
    business_mode: businessMode,
    inventory_type: inventoryType,
    game_type: gameTypeFilter,
    keyword: keyword.trim() || undefined,
    date_from: dateRange?.[0].format("YYYY-MM-DD"),
    date_to: dateRange?.[1].format("YYYY-MM-DD"),
    sort_desc: sortDesc,
  }), [businessMode, inventoryType, gameTypeFilter, keyword, dateRange, sortDesc]);

  const load = useCallback(async () => {
    try {
      const data = await stocksApi.inventoryLedger({ ...filters, limit: pageSize, offset: (page - 1) * pageSize });
      const list = data.items
        .filter(({ account }) => !locallyRemovedIdsRef.current.has(account.id))
        .map(({ account, order }) => toInventoryOrderRow(account, order as InventoryOrderRow));
      const freshIds = new Set(data.items.map(({ account }) => account.id));
      locallyRemovedIdsRef.current.forEach((id) => {
        if (!freshIds.has(id)) locallyRemovedIdsRef.current.delete(id);
      });
      setRows(list);
      setTotalCount(data.total);
      setFacetTotal(data.facet_total);
      setTypeCounts(data.type_counts);
      setServerGameTypes(data.game_types);
      setInventoryStats(data.stats);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    if (active) void load();
  }, [active, load, refreshKey]);

  const countInventoryRows = useCallback((type?: string) => {
    if (type) return typeCounts[type] ?? 0;
    return facetTotal;
  }, [facetTotal, typeCounts]);
  const visibleRows = rows;
  const orderedRows = rows;

  async function handleExport() {
    setExporting(true);
    try {
      const allRows: InventoryOrderRow[] = [];
      let offset = 0;
      while (true) {
        const result = await stocksApi.inventoryLedger({ ...filters, limit: PAGE_SIZE_MAX, offset });
        allRows.push(...result.items.map(({ account, order }) => toInventoryOrderRow(account, order as InventoryOrderRow)));
        offset += result.items.length;
        if (!result.items.length || offset >= result.total) break;
      }
      const detailResults = await Promise.all(allRows.map(async (row) => {
        try {
          return [row.account.id, await ordersApi.executionDetail(row.id)] as const;
        } catch {
          return [row.account.id, undefined] as const;
        }
      }));
      const details = Object.fromEntries(detailResults) as Partial<Record<number, AccountExecutionDetail>>;
      const failedCount = detailResults.filter(([, detail]) => !detail).length;
      downloadInventoryCsv(allRows.map((row) => row.account), details);
      if (failedCount) appMessage.warning(`${failedCount} 条明细读取失败，已导出其余可用字段`);
      else appMessage.success("库存 CSV 已导出");
    } finally {
      setExporting(false);
    }
  }

  return {
    rows, setRows, inventoryStats, businessMode, setBusinessMode,
    inventoryType, setInventoryType, gameTypeFilter, setGameTypeFilter,
    keyword, setKeyword, dateRange, setDateRange, sortDesc, setSortDesc,
    page, setPage, pageSize, setPageSize, error, setError,
    businessOptions, inventoryTypeOptions, gameTypeOptions, load,
    countInventoryRows, visibleRows, orderedRows, totalCount, setTotalCount,
    handleExport, exporting, locallyRemovedIdsRef,
  };
}
