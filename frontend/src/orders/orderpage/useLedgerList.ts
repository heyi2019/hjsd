import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dayjs } from "dayjs";
import { orderTypesApi, ordersApi } from "../../shared/api/orders.api";
import type { Order, OrderType } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { ACCOUNT_STATUS_LABEL, today } from "../../shared/lib/format";
import { filterRetiredOrderTypeOptions } from "../../shared/lib/retiredProducts";
import { useOptionSet } from "../../shared/lib/optionSets";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";
import { appMessage } from "../../shared/ui/appFeedback";
import { filterBusinessOrders, type BusinessFilterKey, type BusinessModeFilterKey } from "./helpers";

type Opt = { value: string; label: string };

/** 交易日是否在筛选区间内（「订单总量」与类型 Segmented 计数共用，避免两处日期判断漂移）。 */
function withinTradeDateRange(order: Order, range: [Dayjs, Dayjs] | null): boolean {
  if (!range) return true;
  const tradeDate = new Date(`${order.trade_date}T00:00:00`);
  return !Number.isNaN(tradeDate.getTime())
    && tradeDate >= range[0].startOf("day").toDate()
    && tradeDate <= range[1].endOf("day").toDate();
}

/**
 * 订单台账「列表域」：数据加载、筛选、分页、排序、导出与选项词典，以及派生的 filteredOrders。
 * 从 useOrdersPageController 拆出，保持纯参数入 / 扁平返回出，不持有任何 modal / 账号动作状态。
 * 这样主 hook 只保留跨域共享枢纽（selectedOrder / actionOrder / users / loadLedgerDetail）与动作编排。
 */
export function useLedgerList(params: { active: boolean; initialMine: boolean }) {
  const { active, initialMine } = params;
  const [orders, setOrders] = useState<Order[]>([]);
  const [types, setTypes] = useState<OrderType[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mineOrders, setMineOrders] = useState(initialMine);
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
  const [businessModeFilter, setBusinessModeFilter] = useState<BusinessModeFilterKey>("all");
  const [gameTypeFilter, setGameTypeFilter] = useState("all");
  const [inventoryStatusFilter, setInventoryStatusFilter] = useState("all");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  // 业务类型、业务模式、责任方和关联关系均来自后端选项词典。
  const orderBusinessOptions: Opt[] = filterRetiredOrderTypeOptions(useOptionSet("ORDER_BUSINESS") ?? []);
  const orderBusinessModeOptions: Opt[] = useOptionSet("ORDER_BUSINESS_MODE") ?? [];
  const inventoryStatusOptions: Opt[] = [
    { value: "all", label: "全部库存状态" },
    ...(["WAITING", "SOLD", "VOID"] as const).map((value) => ({ value, label: ACCOUNT_STATUS_LABEL[value] })),
  ];
  const gameTypeOptions = useMemo(() => {
    const values = Array.from(new Set(orders.map((order) => order.account_game_type).filter((value): value is string => Boolean(value))))
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
    return [{ value: "all", label: "全部游戏类型" }, ...values.map((value) => ({ value, label: value }))];
  }, [orders]);
  const [keyword, setKeyword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, typeList] = await Promise.all([
        ordersApi.list(mineOrders ? { mine: true } : undefined),
        orderTypesApi.list(),
      ]);
      setOrders(list);
      setTypes(typeList);
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setLoading(false);
    }
  }, [mineOrders]);

  // keep-alive：切走再切回不会重挂载。重新激活（active 翻回 true）时重拉列表，
  // 保证在其他入口新建的订单（工作台快捷建单、库存中心售出/寄售/返点）的订单号及时出现在台账。
  useReloadOnActive(active, load);
  useEffect(() => {
    if (active) setMineOrders(initialMine);
  }, [active, initialMine]);

  const typeNames = useMemo(() => Object.fromEntries(types.map((type) => [type.code, type.name])), [types]);
  // 先按业务筛选，再按日期，最后一次排序；避免渲染层重复计算同一批订单。
  const filteredOrders = useMemo(
    () => filterBusinessOrders(orders, orderTypeFilter, businessModeFilter, keyword, gameTypeFilter, inventoryStatusFilter)
      .filter((order) => withinTradeDateRange(order, dateRange))
      .slice()
      .sort((a, b) => (ledgerSortDesc ? b.id - a.id : a.id - b.id)),
    [orders, orderTypeFilter, businessModeFilter, keyword, gameTypeFilter, inventoryStatusFilter, dateRange, ledgerSortDesc],
  );

  // 类型 Segmented 计数基线：应用除「类型」外的全部筛选（关键词/日期/游戏类型/库存状态/业务模式），
  // 保证各类型计数之和恒等于「订单总量」卡片；否则输入关键词后会出现「全部 627 / 订单总量 12」的自相矛盾。
  const typeCountBase = useMemo(
    () => filterBusinessOrders(orders, "all", businessModeFilter, keyword, gameTypeFilter, inventoryStatusFilter)
      .filter((order) => withinTradeDateRange(order, dateRange)),
    [orders, businessModeFilter, keyword, gameTypeFilter, inventoryStatusFilter, dateRange],
  );

  return {
    orders,
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
    typeCountBase,
    load,
  };
}
