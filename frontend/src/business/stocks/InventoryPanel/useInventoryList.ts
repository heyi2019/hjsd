import { appMessage } from "../../../shared/ui/appFeedback";
import { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stocksApi } from "../../../shared/api/stocks.api";
import type { InventoryStats } from "../../../shared/api/types/accounts";
import { normalizeError } from "../../../shared/api/client";
import { downloadBlob } from "../../../shared/api/download";
import { today } from "../../../shared/lib/format";
import { useOptionSet } from "../../../shared/lib/optionSets";
import { inventoryTypeOfOrder, mergeInventoryAccount, type InventoryOrderRow } from "./types";

function toInventoryOrderRow(account: InventoryOrderRow["account"], order: InventoryOrderRow): InventoryOrderRow {
  return mergeInventoryAccount({
    ...order,
    account,
    inventory_type: inventoryTypeOfOrder(order, account),
  }, account);
}

export function useInventoryList({ active = true, refreshKey = 0, initialAgeGtDays }: { active?: boolean; refreshKey?: number; initialAgeGtDays?: number }) {
  const [rows, setRows] = useState<InventoryOrderRow[]>([]);
  const [inventoryStats, setInventoryStats] = useState<InventoryStats | null>(null);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [totalCount, setTotalCount] = useState(0);
  const [facetTotal, setFacetTotal] = useState(0);
  const [businessMode, setBusinessMode] = useState<string | undefined>();
  const [inventoryType, setInventoryType] = useState<string | undefined>();
  const [gameTypeFilter, setGameTypeFilter] = useState<string | undefined>();
  const [inventoryOperatorIds, setInventoryOperatorIds] = useState<number[]>([]);
  const [ageGtDays, setAgeGtDays] = useState<number | undefined>(initialAgeGtDays);
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
    ...(inventoryOperatorIds.length ? { inventory_operator_ids: inventoryOperatorIds } : {}),
    ...(ageGtDays ? { age_gt_days: ageGtDays } : {}),
    keyword: keyword.trim() || undefined,
    date_from: dateRange?.[0].format("YYYY-MM-DD"),
    date_to: dateRange?.[1].format("YYYY-MM-DD"),
    sort_desc: sortDesc,
  }), [businessMode, inventoryType, gameTypeFilter, inventoryOperatorIds, ageGtDays, keyword, dateRange, sortDesc]);

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

  useEffect(() => {
    if (!active) return;
    setAgeGtDays(initialAgeGtDays);
    setPage(1);
  }, [active, initialAgeGtDays]);

  const countInventoryRows = useCallback((type?: string) => {
    if (type) return typeCounts[type] ?? 0;
    return facetTotal;
  }, [facetTotal, typeCounts]);
  async function handleExport() {
    setExporting(true);
    try {
      const result = await stocksApi.inventoryLedgerExport(filters);
      downloadBlob(result.blob, `库存中心_${today()}.csv`);
      if (result.failedDetailCount) appMessage.warning(`${result.failedDetailCount} 条明细读取失败，已导出其余可用字段`);
      else appMessage.success("库存数据已导出");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  }

  return {
    rows, setRows, inventoryStats, businessMode, setBusinessMode,
    inventoryType, setInventoryType, gameTypeFilter, setGameTypeFilter,
    inventoryOperatorIds, setInventoryOperatorIds,
    ageGtDays, setAgeGtDays,
    keyword, setKeyword, dateRange, setDateRange, sortDesc, setSortDesc,
    page, setPage, pageSize, setPageSize, error, setError,
    businessOptions, inventoryTypeOptions, gameTypeOptions, load,
    countInventoryRows, totalCount, setTotalCount,
    handleExport, exporting, locallyRemovedIdsRef,
  };
}
