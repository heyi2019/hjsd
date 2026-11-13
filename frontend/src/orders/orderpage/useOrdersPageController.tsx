

import { useEffect, useState } from "react";
import type { Order } from "../../shared/api/types/orders";
import { currentDevUser } from "../../shared/api/client";
import type { BusinessOrderType } from "../CreateBusinessModal";
import { DEFAULT_BUSINESS_CENTER_TAB, type BusinessCenterEntryTab, type BusinessCenterTab } from "../businessCenter";
import { useLedgerList } from "./useLedgerList";
import { useLedgerColumns } from "./useLedgerColumns";
import { useOrderCancellation } from "./useOrderCancellation";
import { useOrderActionModals } from "./useOrderActionModals";
import { useLedgerInlineEdit } from "./useLedgerInlineEdit";
import { useSession } from "../../shared/state/session";

export function useOrdersPageController(params: {
  active?: boolean;
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
} = {}) {
  const { active = true, initialTab, initialMine = false, onNavigate } = params;
  const currentOperator = currentDevUser();
  const { role } = useSession();
  const canDeleteOrder = role === "admin";

  // —— 列表域：加载 / 筛选 / 分页 / 排序 / 导出 / 选项词典 / 派生 filteredOrders ——
  const list = useLedgerList({ active, initialMine });
  const {
    orders, setOrders, types, setTypes, loadError, setLoadError, loading, setLoading,
    page, setPage, pageSize, setPageSize,
    ledgerSortDesc, setLedgerSortDesc, ledgerExporting, setLedgerExporting,
    exportLedger, exportLedgerXlsx,
    orderTypeFilter, setOrderTypeFilter, businessModeFilter, setBusinessModeFilter,
    gameTypeFilter, setGameTypeFilter, inventoryStatusFilter, setInventoryStatusFilter,
    dateRange, setDateRange, keyword, setKeyword,
    orderBusinessOptions, orderBusinessModeOptions, inventoryStatusOptions,
    gameTypeOptions, typeNames, filteredOrders, typeCountBase, load,
  } = list;

  // —— 建单入口 / 当前选中订单（跨域共享枢纽） ——
  const [createType, setCreateType] = useState<BusinessOrderType | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  // —— 表格详情 / 账号内联编辑枢纽 ——
  const inlineEdit = useLedgerInlineEdit({ setOrders });
  const { loadLedgerDetail, openLedgerEditor } = inlineEdit;

  // —— 冲销 / 取消域：分笔冲销、原路退款、分期合约取消 ——
  const cancellation = useOrderCancellation({ selectedOrder, setSelectedOrder, load });
  const {
    cancelEmployees, setCancelEmployees, cancelForm,
    cancelInstallmentTarget, setCancelInstallmentTarget,
    cancelOrderTarget, setCancelOrderTarget,
    cancelPools, setCancelPools, cancelScope, setCancelScope,
    cancelSubmitting, setCancelSubmitting,
    cancelableEventsForScope, reversibleEvents,
    closeCancelTransaction, openCancelTransaction, submitCancelTransaction,
    sharedCancellationEvent, hasSharedCancellation,
  } = cancellation;

  // —— 订单动作弹窗域：退款 / 分润配置 / 交付 / 下架 / 账号动作 ——
  // 子 hook 内部持有全部弹窗状态；主 hook 用 spread 并集保持对外返回契约不变。
  const actionModals = useOrderActionModals({ selectedOrder, load });
  // openOrderProfile 仅供台账列定义内部点击转发，原本不在对外 return 契约中。
  const { openOrderProfile, ...exposedActionModals } = actionModals;
  const {
    openAllocations, openRefund,
    openOrderRebate, openOrderSale, openOrderConsignment, openOrderOffsale, openOrderDelete,
  } = actionModals;

  const normalizedInitialTab: BusinessCenterTab = initialTab ?? DEFAULT_BUSINESS_CENTER_TAB;
  const [activeTab, setActiveTab] = useState<BusinessCenterTab>(
    normalizedInitialTab,
  );
  useEffect(() => {
    setActiveTab(normalizedInitialTab);
  }, [normalizedInitialTab]);
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  const [installmentRefreshKey, setInstallmentRefreshKey] = useState(0);


  // —— 台账列定义域：纯展示配置 + 点击转发 ——
  const { arrangeLedgerColumns, visibleLedgerColumns } = useLedgerColumns({
    canDeleteOrder,
    ledgerDetails: inlineEdit.ledgerDetails,
    loadLedgerDetail,
    openLedgerEditor,
    openAllocations,
    openRefund,
    openOrderProfile,
    openOrderRebate,
    openOrderSale,
    openOrderConsignment,
    openCancelTransaction,
    openOrderOffsale,
    openOrderDelete,
  });

  return {
    ...exposedActionModals,
    ...inlineEdit,
    activeTab: activeTab,
    arrangeLedgerColumns: arrangeLedgerColumns,
    businessModeFilter: businessModeFilter,
    cancelEmployees: cancelEmployees,
    cancelForm: cancelForm,
    cancelInstallmentTarget: cancelInstallmentTarget,
    cancelOrderTarget: cancelOrderTarget,
    cancelPools: cancelPools,
    cancelScope: cancelScope,
    cancelSubmitting: cancelSubmitting,
    cancelableEventsForScope: cancelableEventsForScope,
    closeCancelTransaction: closeCancelTransaction,
    createType: createType,
    currentOperator: currentOperator,
    dateRange: dateRange,
    filteredOrders: filteredOrders,
    gameTypeFilter: gameTypeFilter,
    gameTypeOptions: gameTypeOptions,
    hasSharedCancellation: hasSharedCancellation,
    installmentRefreshKey: installmentRefreshKey,
    inventoryRefreshKey: inventoryRefreshKey,
    inventoryStatusFilter: inventoryStatusFilter,
    inventoryStatusOptions: inventoryStatusOptions,
    keyword: keyword,
    ledgerColumns: visibleLedgerColumns,
    ledgerExporting: ledgerExporting,
    ledgerSortDesc: ledgerSortDesc,
    load: load,
    loadError: loadError,
    loading: loading,
    onExportLedger: exportLedger,
    onExportLedgerXlsx: exportLedgerXlsx,
    openCancelTransaction: openCancelTransaction,
    orderBusinessModeOptions: orderBusinessModeOptions,
    orderBusinessOptions: orderBusinessOptions,
    orderTypeFilter: orderTypeFilter,
    orders: orders,
    page: page,
    pageSize: pageSize,
    reversibleEvents: reversibleEvents,
    selectedOrder: selectedOrder,
    setActiveTab: setActiveTab,
    setBusinessModeFilter: setBusinessModeFilter,
    setCancelEmployees: setCancelEmployees,
    setCancelInstallmentTarget: setCancelInstallmentTarget,
    setCancelOrderTarget: setCancelOrderTarget,
    setCancelPools: setCancelPools,
    setCancelScope: setCancelScope,
    setCancelSubmitting: setCancelSubmitting,
    setCreateType: setCreateType,
    setDateRange: setDateRange,
    setGameTypeFilter: setGameTypeFilter,
    setInstallmentRefreshKey: setInstallmentRefreshKey,
    setInventoryRefreshKey: setInventoryRefreshKey,
    setInventoryStatusFilter: setInventoryStatusFilter,
    setKeyword: setKeyword,
    setLedgerExporting: setLedgerExporting,
    setLedgerSortDesc: setLedgerSortDesc,
    setLoadError: setLoadError,
    setLoading: setLoading,
    setOrderTypeFilter: setOrderTypeFilter,
    setOrders: setOrders,
    setPage: setPage,
    setPageSize: setPageSize,
    setSelectedOrder: setSelectedOrder,
    setTypes: setTypes,
    sharedCancellationEvent: sharedCancellationEvent,
    submitCancelTransaction: submitCancelTransaction,
    typeCountBase: typeCountBase,
    typeNames: typeNames,
    types: types,
  };

}

export type OrdersPageController = ReturnType<typeof useOrdersPageController>;
